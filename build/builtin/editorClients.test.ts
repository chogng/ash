import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { compileEditorClient } from './editorClients.ts';
import { buildEditorPackage } from './editorPackages.ts';

const repository = resolve(import.meta.dirname, '../..');

test('Academy publishes closed client resources and platform-specific executables without modifying Ash', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-editor-package-'));
	try {
		const binary = join(directory, 'runtime');
		await writeFile(binary, 'fixture executable bytes');
		const output = join(directory, 'submission');
		await buildEditorPackage(join(repository, 'extensions/academy'), [{ targetPlatform: 'darwin-arm64', path: binary }, { targetPlatform: 'win32-x64', path: binary }], output);
		const catalog = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8'));
		assert.equal(catalog.id, 'ash/academy');
		assert.equal(catalog.schemaVersion, 2);
		const adapter = JSON.parse(await readFile(join(output, 'package/editor/ash/editor-extensions.json'), 'utf8'));
		assert.ok(adapter.editorExtensions.every((entry: { activationEvents: unknown; }) => JSON.stringify(entry.activationEvents) === JSON.stringify([{ type: 'onDemand', capability: 'dataChannel' }])));

		assert.deepEqual(catalog.capabilities.filter((capability: { kind: string; }) => capability.kind === 'executable').map((capability: { path: string; }) => capability.path), ['bin/darwin-arm64/ash-academy', 'bin/win32-x64/ash-academy.exe']);
		const manifest = JSON.parse(await readFile(join(output, 'package/editor/package.json'), 'utf8'));
		for (const [path, digest] of [[manifest.ashRuntime.client.entry, manifest.ashRuntime.client.digest], [manifest.ashRuntime.client.style, manifest.ashRuntime.client.styleDigest]]) {
			assert.equal(`sha256:${createHash('sha256').update(await readFile(join(output, 'package/editor', path))).digest('hex')}`, digest);
		}
		const script = await readFile(join(output, 'package/editor/dist/editor.js'), 'utf8');
		assert.match(script, /export function createEditorModule\(host\)/u);
		assert.doesNotMatch(script, /src\/ash|import\(/u);
		const style = await readFile(join(output, 'package/editor/dist/editor.css'), 'utf8');
		assert.ok(style.includes(`data-ash-editor-client="${manifest.ashRuntime.client.sourceDigest}"`));
		const relativeClient = await compileEditorClient(relative(process.cwd(), join(repository, 'extensions/academy')));
		assert.deepEqual(relativeClient.client, manifest.ashRuntime.client, 'A checkout-relative package root resolves to the same closed artifact');
		await assert.rejects(buildEditorPackage(join(repository, 'extensions/academy'), [{ targetPlatform: 'darwin-arm64', path: binary }], output), /existing editor package/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('client bundling rejects direct imports of a service container outside its host contract', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-editor-client-boundary-'));
	try {
		await mkdir(join(directory, 'browser')); await mkdir(join(directory, 'common'));
		const privileged = join(repository, 'src/ash/platform/instantiation/common/instantiationService.ts');
		const entry = join(directory, 'browser/editor.ts');
		await writeFile(entry, `import { InstantiationService } from ${JSON.stringify(relative(dirname(entry), privileged))}; export const instance = InstantiationService;`);
		await assert.rejects(compileEditorClient(directory), /outside its host contract|escapes its package/u);
		await writeFile(entry, `import { InstantiationService } from ${JSON.stringify(privileged)}; export const instance = InstantiationService;`);
		await assert.rejects(compileEditorClient(directory), /outside its host contract|escapes its package/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});


test('client bundling rejects JavaScript helpers outside the native source digest contract', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-editor-client-source-'));
	try {
		await mkdir(join(directory, 'browser')); await mkdir(join(directory, 'common'));
		await writeFile(join(directory, 'browser/editor.ts'), "export { load } from './helper.js';");
		await writeFile(join(directory, 'browser/helper.js'), 'export const load = specifier => import(specifier);');
		await assert.rejects(compileEditorClient(directory), /outside its TS\/CSS contract/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('PDF Viewer packages its declared parser and worker inside verified independent resources', async () => {
	const compiled = await compileEditorClient(join(repository, 'extensions/pdf-viewer'));
	const script = compiled.resources['dist/editor.js'];
	assert.match(script, /export function createEditorModule\(host\)/u);
	assert.match(script, /pdfjs/u);
	assert.match(script, /createObjectURL/u);
	assert.equal(compiled.client.digest, `sha256:${createHash('sha256').update(script).digest('hex')}`);
	assert.match(compiled.resources['dist/editor.css'], /data-ash-editor-client/u);
});

test('client bundling rejects an undeclared npm dependency', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-editor-client-undeclared-'));
	try {
		await mkdir(join(directory, 'browser')); await mkdir(join(directory, 'common'));
		await writeFile(join(directory, 'browser/editor.ts'), "export { getDocument } from 'pdfjs-dist';");
		await assert.rejects(compileEditorClient(directory), /Unsupported editor client dependency/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('Reference Manager builds a closed resource client without Academy or PDF implementations', async () => {
	const compiled = await compileEditorClient(join(repository, 'extensions/reference-manager'));
	const script = compiled.resources['dist/editor.js'];
	assert.match(script, /export function createEditorModule\(host\)/u);
	assert.match(script, /academy\.citations\.v1/u);
	assert.doesNotMatch(script, /pdfjs|class RichTextEditorWidget/u);
	assert.equal(compiled.client.digest, `sha256:${createHash('sha256').update(script).digest('hex')}`);
	assert.match(compiled.resources['dist/editor.css'], /data-ash-editor-client/u);
});

test('portable public editor API allows declared values and rejects private bindings and re-exports', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-public-editor-api-'));
	try {
		await mkdir(join(directory, 'browser')); await mkdir(join(directory, 'common'));
		const api = { apiVersion: 1 as const, modules: { 'base/common/uri.js': ['URI'] }, types: [] };
		const entry = join(directory, 'browser/editor.ts');
		await writeFile(entry, "export { URI } from 'ash:editor/base/common/uri.js';");
		const compiled = await compileEditorClient(directory, api);
		assert.match(compiled.resources['dist/editor.js'], /base\/common\/uri\.js/u);
		assert.doesNotMatch(compiled.resources['dist/editor.js'], /src\/ash/u);
		for (const source of [
			"import { Other } from 'ash:editor/base/common/uri.js'; export { Other };",
			"export { Other } from 'ash:editor/base/common/uri.js';",
			"export * from 'ash:editor/base/common/uri.js';",
			"import { InstantiationService } from 'ash:editor/platform/instantiation/common/instantiationService.js'; export { InstantiationService };",
			"import type { Private } from 'ash:editor/private.js'; export const value: Private = {};",
		]) {
			await writeFile(entry, source);
			await assert.rejects(compileEditorClient(directory, api), /Unsupported editor host binding|named bindings|outside its host contract/u);
		}
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('exported SDK typechecks Academy outside the checkout with no workspace inherited manifests', async () => {
	const { exportExtensionSdk } = await import('./extensionSdk.ts');
	const { execFileSync } = await import('node:child_process');
	const { createRequire } = await import('node:module');
	const directory = await mkdtemp(join(tmpdir(), 'ash-sdk-export-'));
	try {
		const binary = join(directory, 'dev-host');
		await writeFile(binary, 'development host fixture, never executed');
		const sdk = join(directory, 'sdk'); const project = join(directory, 'academy');
		await exportExtensionSdk(sdk, project, binary);
		assert.equal(await readFile(join(sdk, 'types/internal/src/ash/base/common/marked/marked.d.ts'), 'utf8'), await readFile(join(repository, 'src/ash/base/common/marked/marked.d.ts'), 'utf8'), 'Declaration-only dependencies must survive SDK export on every platform');
		const require = createRequire(import.meta.url);
		execFileSync(process.execPath, [resolve(dirname(require.resolve('typescript/package.json')), Object.values(require('typescript/package.json').bin)[0] as string), '-p', join(project, 'tsconfig.json'), '--noEmit'], { cwd: directory, stdio: 'pipe', encoding: 'utf8' });
		for (const manifest of [join(project, 'Cargo.toml'), ...['rust', 'protocol', 'editor-client-build'].map(name => join(sdk, name, 'Cargo.toml'))]) {
			const content = await readFile(manifest, 'utf8');
			assert.doesNotMatch(content, /workspace\s*=\s*true|\/Volumes\/|crates\/external-ext/u);
		}
		const api = JSON.parse(await readFile(join(sdk, 'editor-api.json'), 'utf8'));
		const client = await compileEditorClient(project, api);
		assert.match(client.resources['dist/editor.js'], /export function createEditorModule/u);
		await assert.rejects(exportExtensionSdk(sdk, project, binary), /existing SDK or project/u);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
