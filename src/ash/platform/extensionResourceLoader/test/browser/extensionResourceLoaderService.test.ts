import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { suite, test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { ExtensionResourceLoaderService } from '../../browser/extensionResourceLoaderService.js';
import { toExtensionResourceURI } from '../../common/extensionResourceLoader.js';

suite('Extension resource loader', () => {
	test('reads UTF-8 text and binary bytes with the exact installed catalog generation', async () => {
		const request = { generation: 7, extensionId: 'publisher.sample', path: 'themes/中文 theme.json' };
		const requests: unknown[] = [];
		const bytes = new TextEncoder().encode('{"name":"中文"}');
		const loader = new ExtensionResourceLoaderService(async resource => { requests.push(resource); return bytes; });
		const uri = URI.parse(toExtensionResourceURI(request).toString());
		assert.equal(await loader.readExtensionResource(uri), '{"name":"中文"}');
		assert.deepEqual(await loader.readExtensionResourceBytes(request), bytes);
		assert.deepEqual(requests, [request, request]);
	});

	test('rejects escaping paths and malformed generations before asking the source to read', async () => {
		let reads = 0;
		const loader = new ExtensionResourceLoaderService(async () => { reads++; return new Uint8Array(); });
		for (const path of ['../file', 'a/../file', '/file', 'a\\file', 'a//file', 'a:stream', 'a\0file']) {
			await assert.rejects(loader.readExtensionResourceBytes({ generation: 1, extensionId: 'publisher.sample', path }), /path/u);
		}
		for (const query of ['generation=-1', 'generation=1&other=2', 'generation=9007199254740992']) {
			await assert.rejects(loader.readExtensionResource(URI.from({ scheme: 'ash-extension-resource', authority: 'publisher.sample', path: '/file', query })), /generation/u);
		}
		for (const resource of ['https://registry.example/package.json', 'http://other.example/file', 'file:/outside/file']) {
			await assert.rejects(loader.readExtensionResource(URI.parse(resource)), /installed extension/u);
		}
		assert.equal(reads, 0);
	});

	test('reports unsupported resources in Chinese and rejects invalid UTF-8', async () => {
		const loader = new ExtensionResourceLoaderService(async () => Uint8Array.of(0xff));
		await assert.rejects(loader.readExtensionResource(toExtensionResourceURI({ generation: 1, extensionId: 'publisher.sample', path: 'file' })), TypeError);
		const bundles = JSON.parse(readFileSync(resolve(process.cwd(), 'extensions/language-pack-zh-cn/translations/workbench.json'), 'utf8'));
		setNlsMessages('zh-CN', bundles);
		try {
			await assert.rejects(loader.readExtensionResource(URI.parse('https://other.example/package.json')), { message: '此资源不是已安装扩展的资源。' });
		} finally {
			resetNlsResolver();
		}
	});
});
