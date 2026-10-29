import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { generateBlocksCiMarkdown } from '../screenshotBlocksCi.ts';
import type { ScreenshotManifest } from '../screenshotDiffReport.ts';

test('only blocks-ci fixtures enter the sorted approval list and rendering errors cannot be approved', () => {
	const environment = { platform: 'win32', browserVersion: 'test' };
	const entry = (fixtureId: string, labels: string[]) => ({
		fixtureId,
		labels,
		imageHash: 'a'.repeat(64),
		imagePath: 'images/image.png',
	});
	const manifest = {
		environment,
		fixtures: [entry('z', ['blocks-ci']), entry('ignored', []), entry('a', ['blocks-ci'])],
	};
	const result = generateBlocksCiMarkdown(manifest, 'images-root');
	assert.ok(result.indexOf('#### a') < result.indexOf('#### z'));
	assert.doesNotMatch(result, /ignored/);
	assert.throws(
		() =>
			generateBlocksCiMarkdown(
				{ ...manifest, fixtures: [...manifest.fixtures, { fixtureId: 'broken', labels: [], hasError: true }] },
				'images-root',
			),
		/rendering errors/,
	);
});

test('real blocks-ci command passes unchanged hashes and fails an intentionally changed approval', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'ash-blocks-ci-'));
	try {
		const png = Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=',
			'base64',
		);
		const imageHash = createHash('sha256').update(png).digest('hex');
		await mkdir(resolve(directory, 'images'));
		await writeFile(resolve(directory, 'images', `${imageHash}.png`), png);
		const manifest: ScreenshotManifest = {
			environment: { platform: 'win32', browserVersion: 'test' },
			fixtures: [
				{ fixtureId: 'test/Light', labels: ['blocks-ci'], imageHash, imagePath: `images/${imageHash}.png` },
			],
		};
		const manifestPath = resolve(directory, 'manifest.json');
		const markdownPath = resolve(directory, 'blocks-ci-screenshots.md');
		await writeFile(manifestPath, JSON.stringify(manifest));
		const markdown = generateBlocksCiMarkdown(manifest, 'local-images');
		await writeFile(markdownPath, markdown);
		const command = resolve(import.meta.dirname, '../screenshotBlocksCi.ts');
		const args = [command, manifestPath, markdownPath, 'local-images'];
		const execute = promisify(execFile);
		assert.equal((await execute(process.execPath, args, { windowsHide: true })).stdout, markdown);
		await writeFile(markdownPath, markdown.replace(imageHash, 'b'.repeat(64)));
		await assert.rejects(
			execute(process.execPath, [...args, '--json'], { windowsHide: true }),
			(error: Error & { code?: number; stdout?: string }) => {
				assert.equal(error.code, 1);
				assert.equal(JSON.parse(error.stdout!).replacement, markdown);
				return true;
			},
		);
		assert.equal(await readFile(markdownPath, 'utf8'), markdown.replace(imageHash, 'b'.repeat(64)));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
