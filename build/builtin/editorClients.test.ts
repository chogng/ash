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
		await buildEditorPackage(join(repository, 'extensions/academic'), [{ targetPlatform: 'darwin-arm64', path: binary }, { targetPlatform: 'win32-x64', path: binary }], output);
		const catalog = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8'));
		assert.equal(catalog.id, 'ash/academic');
		assert.equal(catalog.schemaVersion, 2);
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
		const relativeClient = await compileEditorClient(relative(process.cwd(), join(repository, 'extensions/academic')));
		assert.deepEqual(relativeClient.client, manifest.ashRuntime.client, 'A checkout-relative package root resolves to the same closed artifact');
		await assert.rejects(buildEditorPackage(join(repository, 'extensions/academic'), [{ targetPlatform: 'darwin-arm64', path: binary }], output), /existing editor package/u);
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
