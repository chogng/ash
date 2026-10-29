import assert from 'node:assert/strict';
import { test } from 'mocha';
import '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import type {
	ExtensionDescriptor,
	ExtensionRendererClient,
} from '../../../../../platform/extensions/common/extensionApi.js';
import { loadExtensionEditorModule } from '../../browser/extensionEditorModules.js';
import type { ExtensionEditorModuleRequest } from '../../browser/extensionEditor.js';

const admission: ExtensionRendererClient = {
	runtimeId: 'ash.academy',
	apiVersion: 1,
	entry: 'dist/editor.js',
	digest: `sha256:${'a'.repeat(64)}`,
	style: 'dist/editor.css',
	styleDigest: `sha256:${'b'.repeat(64)}`,
	sourceDigest: `sha256:${'c'.repeat(64)}`,
};
const owner = {
	id: 'ash.academy',
	name: 'academy',
	publisher: 'ash',
	version: '1.0.0',
	sourceKind: 'registry',
	rendererClient: admission,
} as ExtensionDescriptor;

function request(read: (path: string) => Promise<Uint8Array>): ExtensionEditorModuleRequest {
	return {
		package: owner,
		generation: 9,
		entry: admission.entry,
		expectedDigest: admission.sourceDigest,
		signal: new AbortController().signal,
		assertCurrent: async () => {},
		resources: new ExtensionResourceLoaderService(resource => {
			assert.equal(resource.extensionId, owner.id);
			assert.equal(resource.generation, 9);
			return read(resource.path);
		}),
	};
}

test('installed editor execution requires backend admission before reading any package bytes', async () => {
	let reads = 0;
	const input = request(async () => {
		reads++;
		return new Uint8Array();
	});
	for (const invalid of [
		{ ...input, package: { ...owner, rendererClient: undefined } },
		{ ...input, entry: 'browser/editor.ts' },
		{ ...input, expectedDigest: admission.digest },
	])
		await assert.rejects(loadExtensionEditorModule(invalid), /unavailable|versions do not match/);
	assert.equal(reads, 0);
});

test('installed module and stylesheet digests are both verified before module evaluation', async () => {
	const bytes = new TextEncoder().encode('package bytes');
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	const digest = `sha256:${Buffer.from(hash).toString('hex')}`;
	for (const corrupt of ['module', 'style']) {
		const input = request(async () => bytes);
		const rendererClient = {
			...admission,
			digest: corrupt === 'module' ? admission.digest : digest,
			styleDigest: corrupt === 'style' ? admission.styleDigest : digest,
		};
		await assert.rejects(
			loadExtensionEditorModule({ ...input, package: { ...owner, rendererClient } }),
			/versions do not match/,
		);
	}
});

test('retirement while installed bytes are loading prevents evaluating the module', async () => {
	const bytes = new DeferredPromise<Uint8Array>();
	const started = new DeferredPromise<void>();
	const input = request(() => {
		started.complete();
		return bytes.p;
	});
	const controller = new AbortController();
	const pending = loadExtensionEditorModule({ ...input, signal: controller.signal });
	const rejected = assert.rejects(pending, { name: 'AbortError' });
	await started.p;
	controller.abort();
	await bytes.complete(new TextEncoder().encode('throw new Error("must not execute")'));
	await rejected;
});

test('catalog admission is rechecked after verifying bytes and before evaluating installed code', async () => {
	const bytes = new TextEncoder().encode('verified but retired package');
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	const digest = `sha256:${Buffer.from(hash).toString('hex')}`;
	const input = request(async () => bytes);
	let validations = 0;
	await assert.rejects(
		loadExtensionEditorModule({
			...input,
			package: { ...owner, rendererClient: { ...admission, digest, styleDigest: digest } },
			assertCurrent: async () => {
				validations++;
				throw new Error('Package admission retired');
			},
		}),
		/Package admission retired/,
	);
	assert.equal(validations, 1);
});
