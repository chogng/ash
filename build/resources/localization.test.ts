import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { extractLocalizationMessages, isLocalizationInput, validateLocalizationTranslation } from './localization.ts';

test('localization watches the same declarations that the scanner accepts', () => {
	const repository = resolve(import.meta.dirname, '../..');
	for (const [path, accepted] of [
		['src/ash/sessions/dormant.ts', true], ['src/ash/test/ignored.ts', false],
		['src/ash/generated/ignored.ts', false], ['src/ash/ignored.test.ts', false],
		['src/ash/feature.css', false], ['extensions/pack/browser/widget.ts', true],
		['extensions/pack/common/schema.ts', true], ['extensions/pack/browser/widget.test.ts', false],
		['extensions/pack/src/extension.ts', false], ['extensions/pack/translations/messages.json', true],
		['extensions/pack/test/messages.json', false], ['extensions/pack/node_modules/messages.json', false],
	] as const) { assert.equal(isLocalizationInput(join(repository, path)), accepted, path); }
});

test('source extraction preserves bundle identities, aliases and original command titles', () => {
	const messages = extractLocalizationMessages([{
		path: 'editor/action.ts', text: `
		import { localize as text, localize2 as title } from '../nls.js';
		import * as nls from '../nls.js';
		text('hello', 'Hello {0}', name);
		title({ bundle: 'ash.menu', key: 'close' }, 'Close');
		nls.localize2({ key: 'undo', comment: ['command'] }, 'Undo');
	` }]);
	assert.deepEqual(messages, { ash: { hello: 'Hello {0}', undo: 'Undo' }, 'ash.menu': { close: 'Close' } });
});

test('source extraction preserves escaped imports and color identifiers', () => {
	assert.deepEqual(extractLocalizationMessages([
		{ path: 'unrelated.ts', text: 'export const answer = 42;' },
		{ path: 'escaped.ts', text: String.raw`import { localize as text } from '../\u006els.js'; text('hello', 'Hello');` },
		{ path: 'color.ts', text: String.raw`regist\u0065rColor('input.background', defaults, { description: 'Input background.' });` },
	]), { ash: { hello: 'Hello', 'color.input.background': 'Input background.' } });
});

test('service and forwarding declarations preserve literal fallbacks without matching unrelated classes', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'settings.ts', text: `
		import { localize } from '../nls.js';
		import { ILocalizationService, localize as label } from '../services/localization/common/localizationService.js';
		class Settings {
			constructor(private readonly localization: ILocalizationService) {}
			label(key: string, fallback: string) { return this.localization.translate('ash.settings', key, fallback); }
			status(key: string, fallback: string) { this.text = localize(key, fallback); }
			language(key: string, fallback: string) { return this.localization.translate('ash.settings', \`lsp.\${key}\`, fallback); }
			setLanguageStatus(key: string, fallback: string) { return this.language(key, fallback); }
			both(key: string, fallback: string) { this.localization.translate('ash.first', key, fallback); this.localization.translate('ash.second', key, fallback); }
			render() {
				this.label('search', 'Search settings');
				this.status('loading', 'Loading…');
				this.language('available', '{0} servers available.');
				this.setLanguageStatus('loading', 'Loading language servers…');
				this.both('shared', 'Shared label');
				this.localization.translate('ash.settings', 'help', 'Help');
				label(this.localization, { bundle: 'ash.regions', key: 'editor' }, 'Editor');
			}
		}
		class Unrelated {
			label(key: string, fallback: string) { return fallback; }
			render() { this.label('search', 'Unrelated'); this.other.translate('ash.settings', 'help', 'Unrelated'); }
		}
	` }]), {
		'ash.settings': { search: 'Search settings', 'lsp.available': '{0} servers available.', 'lsp.loading': 'Loading language servers…', help: 'Help' },
		ash: { loading: 'Loading…' }, 'ash.regions': { editor: 'Editor' },
		'ash.first': { shared: 'Shared label' }, 'ash.second': { shared: 'Shared label' },
	});
});

test('descriptor fallbacks and lazy data-table declarations are extracted without executing owners', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'views.ts', text: `
		export const view = { title: 'Explorer', localizationKey: { bundle: 'ash.views', key: 'explorer' } };
		export const region = { ariaLabel: 'Panel', ariaLabelKey: { bundle: 'ash.regions', key: 'panel' }, viewsAriaLabel: 'Panel views', viewsAriaLabelKey: { bundle: 'ash.regions', key: 'panelViews' } };
		export const dynamic = { title: userTitle, localizationKey: { bundle: 'ash.views', key: 'user' } };
	` }, {
		path: 'settings.ts', text: `
		import { localize } from '../nls.js';
		export const settings = [['setting', () => localize('setting.title', 'Setting')]];
	` }]), {
		'ash.views': { explorer: 'Explorer' }, 'ash.regions': { panel: 'Panel', panelViews: 'Panel views' }, ash: { 'setting.title': 'Setting' },
	});
});

test('conflicting English declarations fail the build', () => {
	assert.throws(() => extractLocalizationMessages([{
		path: 'commands.ts', text: `
		import { localize } from '../nls.js'; localize('open', 'Open'); localize('open', 'Open Folder');
	` }]), /Conflicting English declaration/);
});

test('conflicting English declarations across files report the bundle, key and source', () => {
	assert.throws(() => extractLocalizationMessages([
		{ path: 'editor.ts', text: `import { localize } from './nls.js'; localize('open', 'Open');` },
		{ path: 'files.ts', text: `import { localize2 } from './nls.js'; localize2('open', 'Open Folder');` },
	]), /Conflicting English declaration: ash\/open in files\.ts/);
});

test('repeated English declarations share one entry while different bundles keep their identities', () => {
	assert.deepEqual(extractLocalizationMessages([
		{ path: 'editor.ts', text: `import { localize } from './nls.js'; localize('open', 'Open');` },
		{ path: 'files.ts', text: `import { localize2 } from './nls.js'; localize2('open', 'Open'); localize2({ bundle: 'ash.files', key: 'open' }, 'Open Folder');` },
	]), { ash: { open: 'Open' }, 'ash.files': { open: 'Open Folder' } });
});

test('unrelated imports and dynamic messages do not become localization declarations', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'feature.ts', text: `
		import { localize as other } from './other.js';
		import * as unrelated from './other.js';
		import { localize } from './nls.js';
		other('other', 'Other');
		unrelated.localize('unrelated', 'Unrelated');
		localize(dynamicKey, 'Dynamic key');
		localize('dynamicMessage', dynamicMessage);
		localize('static', \`Static message\`);
	` }]), { ash: { static: 'Static message' } });
});

test('translations for unknown keys fail the build', () => {
	assert.throws(() => validateLocalizationTranslation({ ash: { count: '{0} items' } }, { ash: { unknown: '未知' } }, 'zh-CN'), /Unknown translation/);
});

for (const [name, original, translation, valid] of [
	['reordered parameters', '{0} items in {1}', '{1} 中有 {0} 项', true],
	['repeated parameters', '{0} and {0}', '{0}', true],
	['named parameters', 'Hello {name}', '{name}，你好', true],
	['missing parameters', '{0} items', '项目', false],
	['additional parameters', '{0} items', '{0} 项 {1}', false],
	['renamed parameters', 'Hello {name}', '你好 {other}', false],
] as const) {
	test(`translation validation ${valid ? 'accepts' : 'rejects'} ${name}`, () => {
		const validate = () => validateLocalizationTranslation({ ash: { message: original } }, { ash: { message: translation } }, 'zh-CN');
		if (valid) {
			assert.deepEqual(validate(), { missing: [], unchanged: 0 });
		} else {
			assert.throws(validate, /Translation parameters differ: zh-CN\/ash\/message/);
		}
	});
}

test('theme descriptions are extracted from the owner declarations', () => {
	assert.deepEqual(extractLocalizationMessages([{
		path: 'theme.ts', text: `
		const color = (id: string, description: string) => registerColor(id, defaults, { description, owner: 'theme' });
		color('widget.shadow', 'Shadow around widgets.');
		registerColor('input.background', defaults, { description: 'Input background.', owner: 'theme' });
	` }]), { ash: { 'color.widget.shadow': 'Shadow around widgets.', 'color.input.background': 'Input background.' } });
});

test('explicit source text is covered while absent locale entries remain visible', () => {
	assert.deepEqual(validateLocalizationTranslation({ ash: { channel: 'H', product: 'Ash', missing: 'Find', count: '{0} items' } }, { ash: { channel: 'H', product: 'Ash', count: '{0} 项' } }, 'zh-CN'), { missing: ['ash/missing'], unchanged: 2 });
});

test('clean checkout validates sources and generates catalogs consumed by host and test compilation', async t => {
	const repository = resolve(import.meta.dirname, '../..');
	// ESM resolves the copied plugin through macOS's /var symlink. Use the same
	// canonical root when asserting watcher paths and module identities.
	const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-localization-')));
	t.after(() => rm(root, { recursive: true, force: true }));
	const entry = 'src/ash/workbench/services/localization/common/localizationCatalogs.ts';
	const files = {
		'package.json': JSON.stringify({ type: 'module' }),
		'src/ash/nls.ts': `export function localize(_key: string, message: string): string { return message; }`,
		'src/ash/feature.ts': `import { localize } from './nls.js'; localize('hello', 'Hello');`,
		'src/ash/nested/feature.ts': `import { localize } from '../nls.js'; localize('hello', 'Hello');`,
		'src/ash/ignored.test.ts': `import { localize } from './nls.js'; localize('hello', 'Ignored test');`,
		'src/ash/test/ignored.ts': `import { localize } from '../nls.js'; localize('hello', 'Ignored test directory');`,
		'src/ash/generated/ignored.ts': `import { localize } from '../nls.js'; localize('hello', 'Ignored generated directory');`,
		'src/ash/platform/languagePacks/common/languagePackContract.ts': `export const ASH_LOCALIZATION_CATALOG_VERSION = 'ash-1'; export interface LanguagePackCatalog { readonly schemaVersion: 1; readonly locale: string; readonly languageName: string; readonly localizedLanguageName: string; readonly catalogVersion: string; readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>; } export interface PreinstalledLanguagePack { readonly id: string; readonly version: string; readonly displayName: string; readonly description: string; readonly catalog: LanguagePackCatalog; }`,
		'.build/protocol/typescript/ApprovalModes.ts': `export const APPROVAL_MODE_DEFINITIONS = [];`,
		'.build/protocol/typescript/ProductSlashCommands.ts': `export const PRODUCT_SLASH_COMMANDS = { permission: { description: 'Choose permissions' }, guardian: { description: 'Prepare project background' } };`,
		'localization/languages.json': JSON.stringify(['en'].map(locale => ({ locale, languageName: locale, localizedLanguageName: locale }))),
		'localization/en/messages.json': '{}',
		'localization/preinstalled.json': JSON.stringify(['ash/language-pack-zh-cn']),
		'extensions/language-pack-zh-cn/package.json': JSON.stringify({ name: 'language-pack-zh-cn', publisher: 'ash', version: '1.0.0', displayName: '简体中文', description: 'Chinese', license: 'MIT', ashUiTargets: ['ide', 'agents'], engines: { ash: '*' }, contributes: { localizations: [{ languageId: 'zh-CN', languageName: 'Chinese', localizedLanguageName: '简体中文', translations: [{ id: 'ash', path: 'localization/package.json' }] }] } }),
		'extensions/language-pack-zh-cn/translations/messages.json': JSON.stringify({ ash: { hello: '你好', packageClient: '包内文档' } }),
		'extensions/document-client/package.json': JSON.stringify({ name: 'document-client', publisher: 'ash', version: '1.0.0' }),
		'extensions/document-client/browser/editor.ts': 'export {};',
		'extensions/document-client/common/paragraph.ts': `import { localize } from '../../../src/ash/nls.js'; localize('packageClient', 'Package client');`,
		'extensions/independent/package.json': JSON.stringify({ name: 'independent', publisher: 'ash', version: '1.0.0', browser: './extension.ts', l10n: 'l10n' }),
		'extensions/independent/browser/editor.ts': `import { localize } from '../common/nls.js'; localize('extensionOwned', 'Extension-owned view');`,
		'extensions/independent/common/nls.ts': `export function localize(_key: string, message: string): string { return message; }`,
	};
	for (const [name, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, name)), { recursive: true });
		await writeFile(join(root, name), text);
	}
	for (const file of ['build/resources/localization.ts', 'build/resources/languagePacks.ts', 'build/builtin/extensionManifest.ts', 'build/lib/watchRebuild.ts', 'build/lib/preparedInputs.ts', entry]) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await copyFile(join(repository, file), join(root, file));
	}
	await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
	function run(args: string[]): string {
		const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		return result.stdout;
	}
	// A new language source remains a distributable package without joining host imports.
	const frenchRoot = join(root, 'extensions/language-pack-fr');
	await mkdir(join(frenchRoot, 'translations'), { recursive: true });
	const frenchManifest = JSON.parse(files['extensions/language-pack-zh-cn/package.json']);
	frenchManifest.name = 'language-pack-fr';
	frenchManifest.contributes.localizations[0] = { languageId: 'fr', languageName: 'French', localizedLanguageName: 'Français', translations: [{ id: 'ash', path: 'localization/package.json' }] };
	await writeFile(join(frenchRoot, 'package.json'), JSON.stringify(frenchManifest));
	await writeFile(join(frenchRoot, 'translations/messages.json'), JSON.stringify({ ash: { hello: 'Bonjour' } }));
	run(['build/resources/localization.ts', '--check']);
	await assert.rejects(stat(join(root, '.build/desktop/localization')), { code: 'ENOENT' });
	run(['build/resources/localization.ts']);
	const generated = join(root, '.build/desktop/localization');
	const outputs = (await readdir(generated)).sort();
	assert.deepEqual(outputs, ['extensions', 'localizationCatalog.en.ts', 'localizationCatalog.zh-CN.ts', 'localizationCatalogs.ts']);
	const extensionRoot = join(generated, 'extensions/ash.language-pack-zh-cn');
	assert.deepEqual(JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8')).uiTargets, ['ide', 'agents']);
	const packedCatalog = JSON.parse(await readFile(join(extensionRoot, 'localization/package.json'), 'utf8'));
	assert.equal(packedCatalog.locale, 'zh-CN');
	assert.equal(packedCatalog.bundles.ash.packageClient, '包内文档');
	assert.match(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /Package client/u);
	assert.doesNotMatch(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /extensionOwned|Extension-owned view/u);
	assert.equal(packedCatalog.bundles.ash.extensionOwned, undefined);
	assert.equal(packedCatalog.bundles.ash.hello, '你好');
	const frenchCatalog = JSON.parse(await readFile(join(generated, 'extensions/ash.language-pack-fr/localization/package.json'), 'utf8'));
	assert.equal(frenchCatalog.bundles.ash.hello, 'Bonjour');
	assert.doesNotMatch(await readFile(join(generated, 'localizationCatalogs.ts'), 'utf8'), /Bonjour|language-pack-fr|localizationCatalog.fr/);
	// Remove obsolete compiled catalogs left by the former automatic-preinstall behavior.
	await writeFile(join(generated, 'localizationCatalog.fr.ts'), 'export const obsolete = true;');
	run(['build/resources/localization.ts']);
	await assert.rejects(stat(join(generated, 'localizationCatalog.fr.ts')), { code: 'ENOENT' });
	assert.match(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /"slash.permission.description": "Choose permissions"/u);
	await writeFile(join(root, '.build/protocol/typescript/ProductSlashCommands.ts'), `export const PRODUCT_SLASH_COMMANDS = { permission: { description: 'Choose next-turn permissions' }, guardian: { description: 'Prepare project background' } };`);
	run(['build/resources/localization.ts', '--check']);
	assert.doesNotMatch(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /Choose next-turn permissions/u);
	run(['build/resources/localization.ts']);
	assert.match(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /"slash.permission.description": "Choose next-turn permissions"/u);
	const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
	assert.deepEqual(manifest.engines, { ash: '*' });
	assert.equal(manifest.main, undefined);
	assert.equal(manifest.browser, undefined);
	assert.deepEqual(await readdir(dirname(join(root, entry))), ['localizationCatalogs.ts']);
	const before = await Promise.all(outputs.map(async file => (await stat(join(generated, file), { bigint: true })).mtimeNs));
	run(['build/resources/localization.ts']);
	assert.deepEqual(await Promise.all(outputs.map(async file => (await stat(join(generated, file), { bigint: true })).mtimeNs)), before);
	for (const target of ['main', 'test']) {
		const output = `.build/desktop/${target}`;
		run([join(repository, 'node_modules/@ash/typescript-compiler/bin/tsc'), '--module', 'NodeNext', '--target', 'ES2022', '--rootDir', '.', '--outDir', output, '--types', 'node', '--skipLibCheck', entry]);
		const catalogs = JSON.parse(run(['--input-type=module', '--eval', `import { productLanguagePackCatalogs } from './${output}/${entry.replace(/\.ts$/u, '.js')}'; console.log(JSON.stringify(productLanguagePackCatalogs.map(catalog => [catalog.locale, catalog.bundles.ash.hello])));`]));
		assert.deepEqual(catalogs, [['en', 'Hello'], ['zh-CN', '你好']]);
		const provenance = JSON.parse(run(['--input-type=module', '--eval', `import { builtinLanguagePackCatalogs, preinstalledLanguagePacks } from './${output}/${entry.replace(/\.ts$/u, '.js')}'; console.log(JSON.stringify({ core: builtinLanguagePackCatalogs.map(catalog => catalog.locale), extensions: preinstalledLanguagePacks.map(pack => ({ id: pack.id, catalog: pack.catalog })) }));`]));
		assert.deepEqual(provenance, { core: ['en'], extensions: [{ id: 'ash/language-pack-zh-cn', catalog: packedCatalog }] });
	}
	await writeFile(join(root, 'src/ash/feature.ts'), `import { localize } from './nls.js'; localize('hello', 'Hello again');`);
	await writeFile(join(root, 'src/ash/nested/feature.ts'), `import { localize } from '../nls.js'; localize('hello', 'Hello again');`);
	run(['build/resources/localization.ts', '--check']);
	assert.doesNotMatch(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /Hello again/u);
	run(['build/resources/localization.ts']);
	assert.match(await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8'), /Hello again/u);
	// Use a real Vite watcher: this declaration is outside root and never enters the module graph.
	await mkdir(join(root, 'src/ash/code'));
	await writeFile(join(root, 'src/ash/code/entry.js'), 'export const entry = 1;');
	const dormant = join(root, 'src/ash/nested/dormant.ts');
	const clientDormant = join(root, 'extensions/document-client/common/dormant.ts');
	await writeFile(clientDormant, `import { localize } from '../../../src/ash/nls.js'; localize('clientDormant', 'Package before');`);
	await writeFile(dormant, `import { localize } from '../nls.js'; localize('dormant', 'Before edit');`);
	const { localizationPlugin } = await import(pathToFileURL(join(root, 'build/resources/localization.ts')).href) as typeof import('./localization.ts');
	const server = await createServer({
		configFile: false, root: join(root, 'src/ash/code'), logLevel: 'silent',
		plugins: [localizationPlugin()], optimizeDeps: { noDiscovery: true },
		// Exercise the real watcher without depending on native events in temporary directories.
		server: { port: 0, watch: { usePolling: true, interval: 20 } },
	});
	try {
		await server.listen();
		const deadline = Date.now() + 5_000;
		while ((!server.watcher.getWatched()[dirname(dormant)]?.includes('dormant.ts') || !server.watcher.getWatched()[dirname(clientDormant)]?.includes('dormant.ts')) && Date.now() < deadline) { await delay(20); }
		assert.ok(server.watcher.getWatched()[dirname(dormant)]?.includes('dormant.ts'));
		await server.environments.client.transformRequest('/entry.js');
		assert.equal(server.environments.client.moduleGraph.getModuleById(dormant.replaceAll('\\', '/')), undefined);
		await writeFile(dormant, `import { localize } from '../nls.js'; localize('dormant', 'After edit');`);
		await writeFile(clientDormant, `import { localize } from '../../../src/ash/nls.js'; localize('clientDormant', 'Package after');`);
		const updatedBy = Date.now() + 5_000;
		let catalog = '';
		do {
			catalog = await readFile(join(generated, 'localizationCatalog.en.ts'), 'utf8');
			if (catalog.includes('After edit') && catalog.includes('Package after')) break;
			await delay(20);
		} while (Date.now() < updatedBy);
		assert.match(catalog, /After edit/, 'unimported declarations update the language resource');
		assert.match(catalog, /Package after/, 'unimported package declarations update the language resource');
	} finally { await server.close(); }
	// Large CJK catalogs remain byte-bounded modules while preserving the same runtime contract.
	const largeMessages = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`large.${index}`, '翻译'.repeat(1000)]));
	await writeFile(join(root, 'src/ash/large.ts'), `import { localize } from './nls.js';\n` + Object.keys(largeMessages).map(key => `localize(${JSON.stringify(key)}, ${JSON.stringify('English '.repeat(400))});`).join('\n'));
	await writeFile(join(root, 'extensions/language-pack-zh-cn/translations/large.json'), JSON.stringify({ ash: largeMessages }));
	run(['build/resources/localization.ts']);
	const parts = (await readdir(generated)).filter(file => file.startsWith('localizationMessages.zh-CN.'));
	assert.ok(parts.length >= 5);
	for (const file of parts) { assert.ok((await stat(join(generated, file))).size < 170_000); }
	run([join(repository, 'node_modules/@ash/typescript-compiler/bin/tsc'), '--module', 'NodeNext', '--target', 'ES2022', '--rootDir', '.', '--outDir', '.build/desktop/large', '--types', 'node', '--skipLibCheck', entry]);
	const restored = JSON.parse(run(['--input-type=module', '--eval', `import { productLanguagePackCatalogs } from './.build/desktop/large/${entry.replace(/\.ts$/u, '.js')}'; console.log(JSON.stringify(productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN').bundles.ash));`]));
	for (const [key, value] of Object.entries(largeMessages)) { assert.equal(restored[key], value); }
	await writeFile(join(root, 'src/ash/large.ts'), '');
	await writeFile(join(root, 'extensions/language-pack-zh-cn/translations/large.json'), '{}');
	run(['build/resources/localization.ts']);
	assert.equal((await readdir(generated)).filter(file => file.startsWith('localizationMessages.')).length, 0);
	await writeFile(join(root, 'localization/en/messages.json'), JSON.stringify({ ash: { hello: 'Hello again' } }));
	const duplicate = spawnSync(process.execPath, ['build/resources/localization.ts', '--check'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
	assert.equal(duplicate.error, undefined);
	assert.notEqual(duplicate.status, 0);
	assert.match(duplicate.stderr, /English declaration must live in its owning source module: ash\/hello/u);
	await writeFile(join(root, 'localization/en/messages.json'), JSON.stringify({ ash: { obsolete: 'Unused legacy message' } }));
	const legacy = spawnSync(process.execPath, ['build/resources/localization.ts', '--check'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
	assert.equal(legacy.error, undefined);
	assert.notEqual(legacy.status, 0);
	assert.match(legacy.stderr, /English declaration must live in its owning source module: ash\/obsolete/u);
	await writeFile(join(root, 'localization/en/messages.json'), '{}');
	await writeFile(join(root, 'extensions/language-pack-zh-cn/translations/messages.json'), JSON.stringify({ ash: { unknown: '未知' } }));
	const invalid = spawnSync(process.execPath, ['build/resources/localization.ts', '--check'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
	assert.equal(invalid.error, undefined);
	assert.notEqual(invalid.status, 0);
	assert.match(invalid.stderr, /Unknown translation: zh-CN\/ash\/unknown/u);
	await writeFile(join(root, 'src/ash/nested/feature.ts'), `import { localize } from '../nls.js'; localize('hello', 'Conflicting nested message');`);
	const conflicting = spawnSync(process.execPath, ['build/resources/localization.ts', '--check'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
	assert.equal(conflicting.error, undefined);
	assert.notEqual(conflicting.status, 0);
	assert.match(conflicting.stderr, /Conflicting English declaration: ash\/hello in nested[/\\]feature\.ts/u);
});
