import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { readExtensionUiTargets } from './extensionManifest.ts';

test('every shipped extension explicitly declares its product windows', async () => {
	const root = resolve(import.meta.dirname, '../../extensions');
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === 'node_modules') {
			continue;
		}
		const text = await readFile(join(root, entry.name, 'package.json'), 'utf8').catch(error => {
			if (error.code === 'ENOENT') {
				return undefined;
			}
			throw error;
		});
		if (text === undefined) {
			continue;
		}
		const manifest = JSON.parse(text);
		assert.ok(readExtensionUiTargets(manifest.ashUiTargets), `${entry.name} must declare ashUiTargets`);
	}
});

test('browser packaging excludes independent capabilities and rejects missing JS manifests', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-browser-extensions-'));
	try {
		await mkdir(join(directory, 'build/builtin'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, 'extensions.ts'), join(directory, 'build/builtin/extensions.ts'));
		await copyFile(
			resolve(import.meta.dirname, 'extensionManifest.ts'),
			join(directory, 'build/builtin/extensionManifest.ts'),
		);
		await copyFile(
			resolve(import.meta.dirname, 'extensionWebviews.ts'),
			join(directory, 'build/builtin/extensionWebviews.ts'),
		);
		await mkdir(join(directory, 'build/resources'), { recursive: true });
		await copyFile(
			resolve(import.meta.dirname, '../resources/languagePacks.ts'),
			join(directory, 'build/resources/languagePacks.ts'),
		);
		await mkdir(join(directory, 'localization'), { recursive: true });
		await writeFile(join(directory, 'localization/preinstalled.json'), JSON.stringify(['test/language-pack']));
		await mkdir(join(directory, 'build/lib'), { recursive: true });
		await copyFile(
			resolve(import.meta.dirname, '../lib/preparedInputs.ts'),
			join(directory, 'build/lib/preparedInputs.ts'),
		);
		await symlink(
			resolve(import.meta.dirname, '../../node_modules'),
			join(directory, 'node_modules'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await mkdir(join(directory, 'extensions/theme-defaults/themes'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/theme-defaults/package.json'),
			JSON.stringify({ publisher: 'test', name: 'theme-defaults', version: '1.0.0' }),
		);
		await mkdir(join(directory, 'extensions/capability'));
		await writeFile(
			join(directory, 'extensions/capability/Cargo.toml'),
			'[package]\nname = "capability"\nversion = "1.0.0"\n',
		);
		await mkdir(join(directory, 'extensions/installed-editor'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/installed-editor/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'installed-editor',
				version: '1.0.0',
				ashRuntime: { kind: 'rust', client: { apiVersion: 1, entry: 'dist/editor.js' } },
			}),
		);
		await mkdir(join(directory, 'livekit-server'));
		await writeFile(
			join(directory, 'livekit-server/runtime.json'),
			JSON.stringify({ schemaVersion: 1, id: 'ash.livekit', entrypoint: 'bin/livekit-server' }),
		);
		await mkdir(join(directory, 'extensions/git/src'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/git/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'git',
				version: '1.0.0',
				ashRuntime: { kind: 'rust', entrypoint: 'test-capability' },
			}),
		);
		await writeFile(join(directory, 'extensions/git/src/main.rs'), 'fn main() {}');
		await writeFile(join(directory, 'extensions/git/build.rs'), 'fn main() {}');
		await mkdir(join(directory, 'extensions/git/common'), { recursive: true });
		await writeFile(join(directory, 'extensions/git/common/client.ts'), 'export const internalClient = true;');
		await writeFile(join(directory, 'extensions/git/Cargo.toml'), '[package]');
		await writeFile(
			join(directory, 'extensions/git/package.nls.zh-CN.json'),
			JSON.stringify({ displayName: 'Git 支持' }),
		);
		await mkdir(join(directory, 'extensions/language/tree-sitter/parser/src'), { recursive: true });
		await mkdir(join(directory, 'extensions/language/tree-sitter/nested'), { recursive: true });
		await mkdir(join(directory, 'extensions/language/queries'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/language/package.json'),
			JSON.stringify({ publisher: 'test', name: 'language', version: '1.0.0' }),
		);
		await writeFile(
			join(directory, 'extensions/language/tree-sitter/parser/Cargo.toml'),
			'[package]\nname = "tree-sitter-parser"',
		);
		const parserSource = await open(join(directory, 'extensions/language/tree-sitter/parser/src/parser.c'), 'w');
		try {
			await parserSource.truncate(17 * 1024 * 1024);
		} finally {
			await parserSource.close();
		}
		for (const path of [
			'tree-sitter/parser.wasm',
			'tree-sitter/nested/parser.wasm',
			'tree-sitter/grammars.json',
			'queries/highlights.scm',
			'queries/LICENSE.txt',
		]) {
			await writeFile(join(directory, 'extensions/language', path), path);
		}
		await mkdir(join(directory, 'extensions/language-pack/translations'), { recursive: true });
		const catalog = {
			schemaVersion: 1,
			locale: 'zh-CN',
			catalogVersion: 'ash-1',
			bundles: { ash: { hello: '你好' } },
		};
		await writeFile(
			join(directory, 'extensions/language-pack/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'language-pack',
				version: '1.0.0',
				engines: { ash: '*' },
				contributes: {
					localizations: [
						{ languageId: 'zh-CN', translations: [{ id: 'ash', path: 'localization/package.json' }] },
					],
				},
			}),
		);
		await mkdir(join(directory, '.build/desktop/localization/extensions/test.language-pack/localization'), {
			recursive: true,
		});
		await writeFile(
			join(directory, '.build/desktop/localization/extensions/test.language-pack/localization/package.json'),
			JSON.stringify(catalog),
		);
		await mkdir(join(directory, 'extensions/optional-language'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/optional-language/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'optional-language',
				engines: { ash: '*' },
				contributes: { localizations: [{ languageId: 'fr' }] },
			}),
		);
		await writeFile(join(directory, 'extensions/optional-language/optional.json'), 'French must be downloaded');
		await mkdir(join(directory, 'extensions/optional-keymap'));
		await writeFile(
			join(directory, 'extensions/optional-keymap/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'optional-keymap',
				ashDistribution: 'marketplace',
				contributes: { keybindings: [{ key: 'ctrl+d', command: 'editor.action.addSelectionToNextFindMatch' }] },
			}),
		);
		const language = join(directory, 'extensions/node-language');
		await mkdir(join(language, 'node_modules/fixture-runtime'), { recursive: true });
		await writeFile(
			join(language, 'node_modules/fixture-runtime/package.json'),
			JSON.stringify({ name: 'fixture-runtime', version: '1.0.0', main: 'index.cjs' }),
		);
		await writeFile(
			join(language, 'node_modules/fixture-runtime/index.cjs'),
			'module.exports = "bundled language server";',
		);
		await writeFile(join(language, 'node_modules/fixture-runtime/LICENSE'), 'Synthetic license fixture');
		await writeFile(join(language, 'server.cjs'), 'console.log(require("fixture-runtime"));');
		await writeFile(
			join(language, 'package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'node-language',
				version: '1.0.0',
				ashLanguageServers: {
					version: 2,
					servers: [
						{
							id: 'fixture',
							languages: ['fixture'],
							runtime: 'node',
							entrypoint: 'server.cjs',
							runtimePackages: ['fixture-runtime'],
						},
					],
				},
			}),
		);
		const run = () =>
			spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
				cwd: directory,
				encoding: 'utf8',
				timeout: 15_000,
				// This fixture owns its catalog, including any externally configured roots.
				env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
			});
		const packaged = run();
		assert.ifError(packaged.error);
		assert.equal(packaged.status, 0, packaged.stderr);
		const bundle = JSON.parse(await readFile(join(directory, '.build/builtin/fixture.json'), 'utf8'));
		assert.deepEqual(
			bundle.catalog.extensions.map((extension: { id: string }) => extension.id),
			['test.git', 'test.language', 'test.language-pack', 'test.node-language', 'test.theme-defaults'],
		);
		const nodeResources = bundle.resources['test.node-language'];
		assert.equal(
			Buffer.from(nodeResources['licenses/fixture-runtime/LICENSE'], 'base64').toString(),
			'Synthetic license fixture',
		);
		assert.equal(
			Buffer.from(nodeResources['node_modules/fixture-runtime/index.cjs'], 'base64').toString(),
			'module.exports = "bundled language server";',
		);
		const standalone = join(directory, 'isolated-server.cjs');
		await writeFile(standalone, Buffer.from(nodeResources['server.cjs'], 'base64'));
		const server = spawnSync(process.execPath, [standalone], { cwd: tmpdir(), encoding: 'utf8' });
		assert.equal(server.status, 0, server.stderr);
		assert.equal(server.stdout.trim(), 'bundled language server');
		assert.deepEqual(Object.keys(bundle.resources['test.git']).sort(), ['package.json', 'package.nls.zh-CN.json']);
		assert.deepEqual(Object.keys(bundle.resources['test.language']).sort(), [
			'package.json',
			'queries/LICENSE.txt',
			'queries/highlights.scm',
			'tree-sitter/grammars.json',
			'tree-sitter/nested/parser.wasm',
			'tree-sitter/parser.wasm',
		]);
		assert.equal(
			bundle.catalog.extensions.find((extension: { id: string }) => extension.id === 'test.language-pack')
				.sourceKind,
			'builtIn',
		);
		assert.deepEqual(
			JSON.parse(
				Buffer.from(bundle.resources['test.language-pack']['localization/package.json'], 'base64').toString(
					'utf8',
				),
			),
			catalog,
		);
		await writeFile(join(directory, 'outside.cjs'), 'module.exports = "outside package";');
		await writeFile(join(language, 'server.cjs'), 'require("../../outside.cjs");');
		const escaped = run();
		assert.notEqual(escaped.status, 0);
		assert.match(escaped.stderr, /Language-server source escapes its package/u);
		await writeFile(join(language, 'server.cjs'), 'console.log(require("fixture-runtime"));');
		await mkdir(join(directory, 'extensions/broken-js'));
		const broken = run();
		assert.ifError(broken.error);
		assert.notEqual(broken.status, 0);
		assert.match(broken.stderr, /broken-js[/\\]package\.json/u);
	} finally {
		assert.equal(dirname(directory), tmpdir());
		await rm(directory, { recursive: true, force: true });
	}
});

test('browser Git packages publish their bundled frontend without a Rust runtime', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-combined-extension-'));
	try {
		await mkdir(join(directory, 'build/builtin'), { recursive: true });
		await copyFile(resolve(import.meta.dirname, 'extensions.ts'), join(directory, 'build/builtin/extensions.ts'));
		await copyFile(
			resolve(import.meta.dirname, 'extensionManifest.ts'),
			join(directory, 'build/builtin/extensionManifest.ts'),
		);
		await copyFile(
			resolve(import.meta.dirname, 'extensionWebviews.ts'),
			join(directory, 'build/builtin/extensionWebviews.ts'),
		);
		await mkdir(join(directory, 'build/resources'), { recursive: true });
		await copyFile(
			resolve(import.meta.dirname, '../resources/languagePacks.ts'),
			join(directory, 'build/resources/languagePacks.ts'),
		);
		await mkdir(join(directory, 'localization'), { recursive: true });
		await writeFile(join(directory, 'localization/preinstalled.json'), JSON.stringify(['test/language-pack']));
		await mkdir(join(directory, 'build/lib'), { recursive: true });
		await copyFile(
			resolve(import.meta.dirname, '../lib/preparedInputs.ts'),
			join(directory, 'build/lib/preparedInputs.ts'),
		);
		await symlink(
			resolve(import.meta.dirname, '../node_modules'),
			join(directory, 'build/node_modules'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		for (const name of ['node_modules', 'resources', 'sdk']) {
			await symlink(
				resolve(import.meta.dirname, '../../' + name),
				join(directory, name),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
		}
		await mkdir(join(directory, 'extensions/theme-defaults/themes'), { recursive: true });
		await writeFile(
			join(directory, 'extensions/theme-defaults/package.json'),
			JSON.stringify({ publisher: 'test', name: 'theme-defaults', version: '1.0.0' }),
		);
		await mkdir(join(directory, 'extensions/git/browser'), { recursive: true });
		// Real author packages install the SDK for its types; the Worker must still use its host facade.
		await mkdir(join(directory, 'extensions/git/node_modules/@ash'), { recursive: true });
		await symlink(
			resolve(import.meta.dirname, '../../sdk/typescript'),
			join(directory, 'extensions/git/node_modules/@ash/sdk'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await writeFile(
			join(directory, 'extensions/git/package.json'),
			JSON.stringify({
				publisher: 'test',
				name: 'git',
				version: '1.0.0',
				browser: 'browser/main.ts',
				contributes: {
					commands: [
						{ command: 'test.browser.command', title: 'Ash browser command' },
						{ command: 'test.browser.disposeImage', title: 'Dispose image editor' },
					],
					imageEditors: [{ id: 'test.image', displayName: 'Image' }],
				},
			}),
		);
		await writeFile(
			join(directory, 'extensions/git/browser/main.ts'),
			`import { marker } from './helper.js'; import { commands, window, workspace } from '@ash/sdk';
export function activate(context) {
 const image = window.registerImageEditorProvider('test.image', {resolveImageEditor(_context, view) { view.html = '<p>HTML-only image editor</p>'; }});
 context.subscriptions.push(image, commands.register('test.browser.disposeImage', () => image.dispose()));
 context.subscriptions.push(commands.register('test.browser.command', async () => {
  const configuration = workspace.getConfiguration('sample');
  await configuration.update('enabled', false, 'workspace');
  await configuration.update('enabled', undefined, 'user');
  await window.showInformationMessage('Ash browser command');
  return marker;
 }));
}`,
		);
		await writeFile(
			join(directory, 'extensions/git/browser/helper.ts'),
			"export const marker: string = 'combined-entry-marker';",
		);
		await writeFile(join(directory, 'extensions/git/browser/sample.ts'), 'export const sample = 1;');
		const run = () => {
			const result = spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
				cwd: directory,
				encoding: 'utf8',
				timeout: 30_000,
				env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
		};
		run();
		const bundle = JSON.parse(await readFile(join(directory, '.build/builtin/fixture.json'), 'utf8'));
		const publicationPath = join(directory, '.build/builtin/current.json');
		const publication = async () =>
			JSON.parse(await readFile(publicationPath, 'utf8')) as {
				builtIn: string[];
				packageNames: Record<string, string>;
			};
		const firstPublication = await publication();
		const gitSnapshot = firstPublication.builtIn.find(id => firstPublication.packageNames[id] === 'git')!;
		const preparedEntry = join(directory, '.build/builtin/packages', gitSnapshot, 'browser/main.ts');
		assert.equal(
			await readFile(preparedEntry, 'utf8'),
			Buffer.from(bundle.resources['test.git']['browser/main.ts'], 'base64').toString('utf8'),
		);
		assert.deepEqual(Object.keys(bundle.resources['test.git']).sort(), [
			'browser/main.ts',
			'browser/sample.ts',
			'package.json',
		]);
		const module = Buffer.from(bundle.resources['test.git']['browser/main.ts'], 'base64').toString('utf8');
		assert.match(module, /combined-entry-marker/);
		assert.doesNotMatch(module, /from ['"]\.\/helper\.js['"]|Promise<string>/);
		const exercised = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('../package.json', pathToFileURL(process.argv[1])), 'utf8'));
globalThis.__ashConfiguration = { extensionId: manifest.publisher + '.' + manifest.name, extensionPath: '/', commands: manifest.contributes.commands, manifest };
globalThis.__ashInitialization = { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: { defaults: {contents: {}, keys: [], overrides: []}, folders: []} };
globalThis.__ashInvocation = () => 1;
const changes = [];
globalThis.__ashRegistrationsChanged = snapshot => changes.push(snapshot);
const requests = [];
globalThis.__ashRequest = async (_id, encoded) => { requests.push(JSON.parse(encoded)); return JSON.stringify({result: 'done'}); };
const runtime = await import(pathToFileURL(process.argv[1]).href);
const registrations = await runtime.activate();
assert(registrations.some(value => value.kind === 'command' && value.registrationId === 'test.browser.command'));
assert(registrations.some(value => value.kind === 'dataChannel' && value.registrationId === 'test.image'));
assert.deepEqual(await runtime.invoke('test.image', {data: {source: 'screen'}}, 2, 'receiveData'), {html: '<p>HTML-only image editor</p>', resources: [], state: null});
await runtime.invoke('test.browser.disposeImage', {arguments: []}, 3, 'execute');
assert.equal(changes.length, 1);
assert.equal(changes[0].registrations.some(value => value.registrationId === 'test.image'), false);
await assert.rejects(runtime.invoke('test.image', {data: {source: 'screen'}}, 4, 'receiveData'), /disposed/);
assert.equal(await runtime.invoke('test.browser.command', {arguments: []}, 1, 'execute'), 'combined-entry-marker');
assert.deepEqual(requests, [
 {operation: 'updateConfiguration', section: 'sample.enabled', value: false, target: 'workspace'},
 {operation: 'resetConfiguration', section: 'sample.enabled', target: 'user'},
 {operation: 'showMessage', message: 'Ash browser command', severity: 'information'}
]);
await runtime.deactivate();
await assert.rejects(runtime.invoke('test.browser.command', {arguments: []}, 1, 'execute'), /not active|disposed/);
`,
				preparedEntry,
			],
			{ cwd: directory, encoding: 'utf8', timeout: 15_000 },
		);
		assert.ifError(exercised.error);
		assert.equal(exercised.status, 0, exercised.stdout + exercised.stderr);
		const cache = join(directory, '.build/browser-extensions');
		const snapshots = async () =>
			Object.fromEntries(
				await Promise.all(
					(await readdir(cache)).map(async name => [
						name,
						(await stat(join(cache, name), { bigint: true })).mtimeNs,
					]),
				),
			);
		const first = await snapshots();
		run();
		assert.deepEqual(await snapshots(), first, 'a new process reuses the compiled package');
		assert.deepEqual(await publication(), firstPublication, 'unchanged packages retain immutable directories');
		await mkdir(join(directory, 'extensions/other'));
		await writeFile(
			join(directory, 'extensions/other/package.json'),
			JSON.stringify({ publisher: 'test', name: 'other', version: '1.0.0', browser: 'main.ts' }),
		);
		await writeFile(join(directory, 'extensions/other/main.ts'), 'export const activate = () => 2;');
		run();
		const both = await snapshots();
		assert.equal(Object.keys(both).length, 2);
		assert.equal(both[Object.keys(first)[0]!], Object.values(first)[0]);
		assert(
			(await publication()).builtIn.includes(gitSnapshot),
			'adding another package preserves existing package identities',
		);
		const catalog = join(directory, '.build/builtin/fixture.json');
		const published = (await stat(catalog, { bigint: true })).mtimeNs;
		await writeFile(
			join(directory, 'extensions/git/browser/helper.ts'),
			"export const marker: 'combined-entry-marker' = 'combined-entry-marker';",
		);
		run();
		assert.equal(
			(await stat(catalog, { bigint: true })).mtimeNs,
			published,
			'type-only edits do not publish a changed snapshot',
		);
		const edited = await snapshots();
		assert.equal(
			Object.keys(edited).filter(key => edited[key] !== both[key]).length,
			1,
			'only the affected package is rebuilt',
		);
		await writeFile(join(directory, 'extensions/git/browser/shared.ts'), "export const external = 'external-one';");
		await writeFile(
			join(directory, 'extensions/git/browser/helper.ts'),
			"export { external as marker } from './shared.js';",
		);
		run();
		const dependencies = await snapshots();
		await writeFile(join(directory, 'extensions/git/browser/shared.ts'), "export const external = 'external-two';");
		run();
		assert.equal(Object.keys(dependencies).filter(key => dependencies[key] !== edited[key]).length, 1);
		const dependentEdit = await snapshots();
		assert.equal(
			Object.keys(dependentEdit).filter(key => dependentEdit[key] !== dependencies[key]).length,
			1,
			'package module edits invalidate only their consumer',
		);
		const latest = JSON.parse(await readFile(catalog, 'utf8'));
		assert.match(
			Buffer.from(latest.resources['test.git']['browser/main.ts'], 'base64').toString('utf8'),
			/external-two/,
		);
		assert.match(
			await readFile(preparedEntry, 'utf8'),
			/combined-entry-marker/,
			'published old bytes remain frozen',
		);
		const beforeCorruption = await publication();
		const currentGit = beforeCorruption.builtIn.find(id => beforeCorruption.packageNames[id] === 'git')!;
		const corruptedEntry = join(directory, '.build/builtin/packages', currentGit, 'browser/main.ts');
		await writeFile(corruptedEntry, 'tampered');
		run();
		const repaired = await publication();
		assert(!repaired.builtIn.includes(currentGit), 'corrupt artifacts are replaced rather than overwritten');
		assert.equal(await readFile(corruptedEntry, 'utf8'), 'tampered');
		assert(beforeCorruption.builtIn.filter(id => id !== currentGit).every(id => repaired.builtIn.includes(id)));
		await rm(catalog);
		run();
		assert.deepEqual(
			await snapshots(),
			dependentEdit,
			'a missing published catalog is restored from package caches',
		);
		await writeFile(
			join(directory, 'tsconfig.json'),
			JSON.stringify({ compilerOptions: { useDefineForClassFields: true } }),
		);
		run();
		const configured = await snapshots();
		assert.equal(
			Object.keys(configured).filter(key => configured[key] !== dependentEdit[key]).length,
			2,
			'shared compiler settings invalidate both bundles',
		);
		const accepted = await publication();
		await writeFile(join(directory, 'shared.ts'), "export const external = 'private-host-module';");
		await symlink(join(directory, 'shared.ts'), join(directory, 'extensions/git/browser/private-link.ts'));
		for (const source of [
			"export { external as marker } from '../../../shared.ts';",
			"export { external as marker } from 'unlisted-host-package';",
			"import type { external } from '../../../shared.ts'; export const marker = 'typed-import';",
			"export type Private = import('../../../shared.ts').external; export const marker = 'typed-query';",
			"export { external as marker } from './private-link.ts';",
			"import type { external } from './private-link.ts'; export const marker = 'typed-symlink';",
		]) {
			await writeFile(join(directory, 'extensions/git/browser/helper.ts'), source);
			const rejected = spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
				cwd: directory,
				encoding: 'utf8',
				timeout: 30_000,
				env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
			});
			assert.ifError(rejected.error);
			assert.notEqual(rejected.status, 0, source);
			assert.match(rejected.stderr, /escapes its package|declared dependency or @ash\/sdk/);
			assert.deepEqual(
				await publication(),
				accepted,
				'a rejected import cannot replace the admitted package snapshot',
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

for (const resource of ['manifest', 'file'] as const) {
	test(`browser packaging rejects an oversized ${resource} before publishing its snapshot`, async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-extension-budget-'));
		try {
			// This fixture must fail on its own budget, independently of generated
			// language packs or other resources in the developer's checkout.
			await mkdir(join(directory, 'build/builtin'), { recursive: true });
			await copyFile(
				resolve(import.meta.dirname, 'extensions.ts'),
				join(directory, 'build/builtin/extensions.ts'),
			);
			await copyFile(
				resolve(import.meta.dirname, 'extensionManifest.ts'),
				join(directory, 'build/builtin/extensionManifest.ts'),
			);
			await copyFile(
				resolve(import.meta.dirname, 'extensionWebviews.ts'),
				join(directory, 'build/builtin/extensionWebviews.ts'),
			);
			await mkdir(join(directory, 'build/resources'), { recursive: true });
			await copyFile(
				resolve(import.meta.dirname, '../resources/languagePacks.ts'),
				join(directory, 'build/resources/languagePacks.ts'),
			);
			await mkdir(join(directory, 'localization'), { recursive: true });
			await writeFile(join(directory, 'localization/preinstalled.json'), JSON.stringify(['test/language-pack']));
			await mkdir(join(directory, 'build/lib'), { recursive: true });
			await copyFile(
				resolve(import.meta.dirname, '../lib/preparedInputs.ts'),
				join(directory, 'build/lib/preparedInputs.ts'),
			);
			await symlink(
				resolve(import.meta.dirname, '../../node_modules'),
				join(directory, 'node_modules'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			const packageRoot = join(directory, 'extensions/budget');
			await mkdir(packageRoot, { recursive: true });
			await writeFile(
				join(packageRoot, 'package.json'),
				JSON.stringify({ publisher: 'test', name: 'budget', version: '1.0.0' }),
			);
			const path = join(packageRoot, resource === 'manifest' ? 'package.json' : 'large.bin');
			const file = await open(path, 'w');
			try {
				await file.truncate((resource === 'manifest' ? 4 : 16) * 1024 * 1024 + 1);
			} finally {
				await file.close();
			}
			const result = spawnSync(process.execPath, ['build/builtin/extensions.ts'], {
				cwd: directory,
				env: { ...process.env, ASH_WEB_EXTENSION_PATHS: '' },
				encoding: 'utf8',
				timeout: 30_000,
			});
			assert.equal(result.status, 1);
			assert.match(
				result.stderr,
				resource === 'manifest' ? /manifest exceeds its byte limit/ : /exceeds its resource budget/,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
}
