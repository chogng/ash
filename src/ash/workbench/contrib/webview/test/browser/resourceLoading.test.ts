import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { MemoryFileService } from '../../../bulkEdit/test/browser/bulkEditTestServices.js';
import { loadLocalResource } from '../../browser/resourceLoading.js';
import { asWebviewUri } from '../../common/webview.js';

suite('Webview resource loading', () => {
	test('serves shared MIME mappings while preserving script, font and unknown resource types', async () => {
		const root = URI.file('/workspace/assets');
		const expected = [
			['photo.AVIF', 'image/avif'],
			['script.mjs', 'text/javascript'],
			['style.css', 'text/css'],
			['data.json', 'application/json'],
			['font.woff2', 'font/woff2'],
			['report.pdf', 'application/pdf'],
			['unknown.extension', 'application/octet-stream'],
		] as const;
		const files = new MemoryFileService(expected.map(([name]) => [URI.joinPath(root, name), name]));
		using fileService = createTestFileService(files);
		const responses = await Promise.all(expected.map(async ([name]) => {
			const result = await loadLocalResource(URI.joinPath(root, name), { roots: [root] }, fileService, CancellationToken.None);
			return result.status === 200 ? [name, result.mimeType] : [name, result.status];
		}));
		assert.deepEqual(responses, expected);
	});

	test('loads exact bytes with the content type and rejects roots, sibling prefixes and traversal before reading', async () => {
		const root = URI.parse('file:///workspace/assets');
		const file = URI.parse('file:///workspace/assets/icon.SVG');
		const files = new MemoryFileService([[file, '<svg/>']]);
		const read = files.readFile.bind(files);
		const reads: string[] = [];
		files.readFile = resource => { reads.push(resource.toString()); return read(resource); };
		using fileService = createTestFileService(files);
		const result = await loadLocalResource(file, { roots: [root] }, fileService, CancellationToken.None);
		using fileService2 = createTestFileService(files);
		const denied = await Promise.all([
			root,
			URI.parse('file:///workspace/assets-other/icon.svg'),
			URI.parse('file:///workspace/assets/../secret.svg'),
			URI.parse('ash-remote://other/workspace/assets/icon.svg'),
		].map(resource => loadLocalResource(resource, { roots: [root] }, fileService2, CancellationToken.None)));
		assert.deepEqual({ result, denied: denied.map(response => response.status), reads }, {
			result: { status: 200, mimeType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') },
			denied: [403, 403, 403, 403],
			reads: [file.toString()],
		});
	});

	test('does not deliver a read completed after its document is cancelled', async () => {
		using cancellation = new CancellationTokenSource();
		const file = URI.parse('file:///workspace/image.png');
		const files = new MemoryFileService([[file, 'image']]);
		const read = files.readFile.bind(files);
		let finish!: () => void;
		const pending = new Promise<void>(resolve => { finish = resolve; });
		files.readFile = async resource => { await pending; return read(resource); };
		using fileService = createTestFileService(files);
		const result = loadLocalResource(file, { roots: [URI.parse('file:///workspace')] }, fileService, cancellation.token);
		cancellation.cancel();
		finish();
		await assert.rejects(result, { name: 'CancellationError' });
	});

	test('maps local and remote paths without losing authority, escaped names or relative CSS dependencies', () => {
		const source = URI.parse('ash-remote://ssh-example/workspace/space%20dir/style.css');
		const uri = asWebviewUri(source);
		assert.deepEqual({ uri: uri.toString(), sibling: new URL('./image.svg', uri.toString()).href }, {
			uri: 'https://resources.ash-webview.invalid/ash-remote/assh-example/workspace/space%20dir/style.css',
			sibling: 'https://resources.ash-webview.invalid/ash-remote/assh-example/workspace/space%20dir/image.svg',
		});
	});
});
