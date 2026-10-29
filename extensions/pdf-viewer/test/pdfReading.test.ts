import assert from 'node:assert/strict';
import { after, before, test } from 'mocha';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { createRequire } from 'node:module';
// The unit runner executes a compiled snapshot; resolve the author's declared dependencies.
const require = createRequire(resolve('extensions/pdf-viewer/package.json'));
const { Client } =
	require('@modelcontextprotocol/sdk/client/index.js') as typeof import('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } =
	require('@modelcontextprotocol/sdk/client/stdio.js') as typeof import('@modelcontextprotocol/sdk/client/stdio.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
import { buildPdfReadingPackage } from '../ai/package.js';
import { pdfReadingFixture } from './pdfReadingFixture.js';

let root: string;
let path: string;
let sha256: string;
let client: McpClient;
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const decoded = (result: Awaited<ReturnType<McpClient['callTool']>>): any => {
	assert.notEqual(result.isError, true, JSON.stringify(result));
	const content = result.content as { type: string; text?: string }[];
	return JSON.parse(content.find(item => item.type === 'text')!.text!);
};

before(async function () {
	this.timeout(60000);
	root = await mkdtemp(join(tmpdir(), 'ash-pdf-ai-tests-'));
	path = join(root, 'fixture.pdf');
	const bytes = pdfReadingFixture();
	sha256 = digest(bytes);
	await writeFile(path, bytes);
	await buildPdfReadingPackage(resolve('extensions/pdf-viewer'), join(root, 'submission'));
	client = new Client({ name: 'ash-pdf-test', version: '1' });
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [join(root, 'submission/package/server/launch')],
			stderr: 'pipe',
			env: { TMPDIR: root },
		}),
	);
});
after(async () => {
	await client?.close();
	if (root) {
		try {
			assert.deepEqual(
				(await readdir(root)).filter(name => name.startsWith('ash-pdf-canvas-')),
				[],
				'Native library temporary directory is released on transport close',
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});

test('PDF MCP discovers tools and reads unopened text with exact source identity and continuation', async () => {
	assert.deepEqual(
		(await client.listTools()).tools.map(tool => tool.name),
		['pdf_read', 'pdf_render_page'],
	);
	const first = decoded(
		await client.callTool({
			name: 'pdf_read',
			arguments: { path, start_page: 1, end_page: 1, max_characters: 12 },
		}),
	);
	assert.equal(first.source.sha256, sha256);
	assert.equal(first.source.page_count, 3);
	assert.equal(first.pages[0].text, 'Revenue: 42 ');
	assert.equal(first.pages[0].truncated, true);
	const next = decoded(
		await client.callTool({
			name: 'pdf_read',
			arguments: { path, end_page: 1, ...first.continuation, expected_sha256: sha256 },
		}),
	);
	assert.equal(next.pages[0].text.startsWith('million'), true);
	assert.equal(next.next_page, 2);
	assert.equal(next.continuation, null);
	assert.equal(digest(await readFile(path)), sha256);
});

test('PDF regions select text in page coordinates without reading other runs', async () => {
	const result = decoded(
		await client.callTool({
			name: 'pdf_read',
			arguments: { path, start_page: 1, region: { x: 0, y: 0, width: 1, height: 0.15 } },
		}),
	);
	assert.match(result.pages[0].text, /Revenue: 42 million/u);
	assert.doesNotMatch(result.pages[0].text, /Forecast/u);
	assert.equal(result.pages.length, 1);
});

test('PDF rotated-page text regions and cropped images use the same visible coordinates', async () => {
	const rotated = join(root, 'rotated.pdf');
	await writeFile(rotated, pdfReadingFixture(90));
	const region = { x: 0.85, y: 0, width: 0.15, height: 1 };
	const text = decoded(await client.callTool({ name: 'pdf_read', arguments: { path: rotated, region } }));
	assert.match(text.pages[0].text, /Revenue: 42 million/u);
	assert.doesNotMatch(text.pages[0].text, /Forecast/u);
	const crop = decoded(
		await client.callTool({
			name: 'pdf_render_page',
			arguments: { path: rotated, page: 1, region, max_dimension: 800 },
		}),
	);
	assert.equal(crop.height, 800);
	assert.ok(crop.width < 160);
	assert.deepEqual(crop.region, region);
});

test('PDF scan and chart produce actual bounded images with no fabricated OCR text', async () => {
	const scan = decoded(await client.callTool({ name: 'pdf_read', arguments: { path, start_page: 3 } }));
	assert.equal(scan.pages[0].has_text, false);
	assert.equal(scan.pages[0].text, '');
	for (const page of [2, 3]) {
		const result = await client.callTool({
			name: 'pdf_render_page',
			arguments: { path, page, max_dimension: 800, expected_sha256: sha256 },
		});
		const info = decoded(result);
		const image = (result.content as { type: string; data: string; mimeType: string }[]).find(
			item => item.type === 'image',
		)!;
		assert.equal(image.mimeType, 'image/png');
		assert.equal(info.page, page);
		assert.equal(Math.max(info.width, info.height), 800);
		assert.equal(info.source.sha256, sha256);
		const bytes = Buffer.from(image.data, 'base64');
		assert.ok(bytes.length <= 700000);
		const decodedImage = await loadImage(bytes);
		const canvas = createCanvas(info.width, info.height);
		const context = canvas.getContext('2d');
		context.drawImage(decodedImage, 0, 0);
		const pixels = context.getImageData(0, 0, info.width, info.height).data;
		assert.ok(
			pixels.some(
				(value, index) => index % 4 === 0 && value > 150 && pixels[index + 1] < 130 && pixels[index + 2] < 100,
			) || page === 2,
		);
		assert.ok(
			pixels.some((value, index) => index % 4 === 0 && value < 80 && pixels[index + 2] > 150) || page === 3,
		);
	}
});

test('PDF tool rejects stale versions, malformed files, out-of-range pages and invalid arguments', async () => {
	for (const args of [
		{ expected_sha256: '0'.repeat(64) },
		{ start_page: 4 },
		{ end_page: 30 },
		{ max_characters: 0 },
		{ extra: true },
		{ region: { x: 0.9, y: 0, width: 0.2, height: 1 } },
	]) {
		const result = await client.callTool({ name: 'pdf_read', arguments: { path, ...args } });
		assert.equal(result.isError, true, JSON.stringify(result));
	}
	const invalid = join(root, 'invalid.pdf');
	await writeFile(invalid, '%PDF-1.4\ninvalid');
	assert.equal((await client.callTool({ name: 'pdf_read', arguments: { path: invalid } })).isError, true);
	assert.equal((await client.callTool({ name: 'pdf_read', arguments: { path: root } })).isError, true);
});

test('PDF saved annotations require explicit selection and do not include viewer drafts', async () => {
	const sidecar = path + '.ash-annotations.json';
	await writeFile(
		sidecar,
		JSON.stringify({
			version: 1,
			annotations: [
				{
					id: 'note',
					kind: 'note',
					page: 1,
					point: { x: 0.5, y: 0.5 },
					text: 'Check revenue',
					color: '#f6c945',
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
				},
			],
		}),
	);
	assert.equal(
		decoded(await client.callTool({ name: 'pdf_read', arguments: { path } })).saved_annotations,
		undefined,
	);
	const result = decoded(
		await client.callTool({ name: 'pdf_read', arguments: { path, include_saved_annotations: true } }),
	);
	assert.equal(result.saved_annotations.saved_only, true);
	assert.equal(result.saved_annotations.source_version_bound, false);
	assert.equal(result.saved_annotations.annotations[0].text, 'Check revenue');
});

test('PDF MCP cancellation frees parser workers and the transport accepts later reads', async () => {
	for (let i = 0; i < 3; i++) {
		const controller = new AbortController();
		const pending = client.callTool({ name: 'pdf_render_page', arguments: { path, page: 3 } }, undefined, {
			signal: controller.signal,
		});
		// callTool dispatches before returning. A timer can run after the render response under load.
		controller.abort('test cancellation');
		await assert.rejects(pending, /test cancellation/u);
	}
	await client.ping();
	const result = decoded(
		await client.callTool({ name: 'pdf_read', arguments: { path, start_page: 2, end_page: 2 } }),
	);
	assert.match(result.pages[0].text, /Regional revenue/u);
});
