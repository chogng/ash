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
		assert.equal(await loader.supportsExtensionGalleryResources(), false);
		assert.equal(await loader.getExtensionGalleryResourceURL({ publisher: 'publisher', name: 'sample', version: '1.0.0' }), undefined);
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
		assert.equal(reads, 0);
	});

	test('builds a configured gallery URL and reads its package-relative resource through the source', async () => {
		const requests: unknown[] = [];
		let template = 'https://registry.example/custom/api/{publisher}/{name}/universal/{version}/file/{path}';
		const loader = new ExtensionResourceLoaderService(async () => { throw new Error('Unexpected installed read'); }, {
			template: async () => template,
			read: async request => { requests.push(request); return new TextEncoder().encode('gallery resource'); },
		});
		const extension = { publisher: 'publisher', name: 'sample', version: '1.0.0' };
		const root = await loader.getExtensionGalleryResourceURL(extension);
		assert.equal(root?.toString(), 'https://registry.example/custom/api/publisher/sample/universal/1.0.0/file/');
		const uri = (await loader.getExtensionGalleryResourceURL(extension, 'themes/中文 theme.json'))!;
		assert.equal(await loader.supportsExtensionGalleryResources(), true);
		assert.equal(await loader.isExtensionGalleryResource(uri), true);
		assert.equal(await loader.readExtensionResource(URI.parse(uri.toString())), 'gallery resource');
		assert.deepEqual(requests, [{ resourceUrlTemplate: template, ...extension, path: 'themes/中文 theme.json' }]);
		for (const candidate of [uri.with({ authority: 'registry.example.attacker' }), uri.with({ path: '/outside/package.json' }), uri.with({ query: 'other=1' }), uri.with({ scheme: 'http' })]) {
			assert.equal(await loader.isExtensionGalleryResource(candidate), false);
			await assert.rejects(loader.readExtensionResource(candidate), /outside/u);
		}
		assert.equal(await loader.getExtensionGalleryResourceURL({ ...extension, targetPlatform: 'linux-x64' }), undefined);
		template = 'https://other.example/api/{publisher}/{name}/universal/{version}/file/{path}';
		assert.equal(await loader.isExtensionGalleryResource(uri), false);
		assert.equal((await loader.getExtensionGalleryResourceURL(extension))?.authority, 'other.example');
	});

	test('reports unsupported resources in Chinese and rejects invalid UTF-8', async () => {
		const loader = new ExtensionResourceLoaderService(async () => Uint8Array.of(0xff));
		await assert.rejects(loader.readExtensionResource(toExtensionResourceURI({ generation: 1, extensionId: 'publisher.sample', path: 'file' })), TypeError);
		const bundles = JSON.parse(readFileSync(resolve(process.cwd(), 'localization/zh-CN/workbench.json'), 'utf8'));
		setNlsMessages('zh-CN', bundles);
		try {
			await assert.rejects(loader.readExtensionResource(URI.parse('https://other.example/package.json')), { message: '此资源不属于已配置的扩展市场。' });
		} finally {
			resetNlsResolver();
		}
	});
});
