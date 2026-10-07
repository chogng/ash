import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IHostColorSchemeService } from '../../common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../../browser/browserHostColorSchemeService.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { resolveSemanticTokenPresentation } from '../../../../../editor/common/services/semanticTokensStyling.js';
import { lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { URI } from '../../../../../base/common/uri.js';
import { WorkbenchThemesRegistry } from '../../../../common/theme.js';
import { loadUserThemes, WorkbenchThemeService } from '../../browser/workbenchThemeService.js';
import { createExtensionWorkbenchColorTheme, parseExtensionTheme } from '../../../extensions/common/extensionTheme.js';
import { projectColorThemeTokens } from '../../../textMate/common/textMateThemeProjection.js';
import { loadColorThemeDocument, loadUserColorTheme, parseUserColorTheme, resolveColorThemeDocument, serializeUserColorThemeDraft } from '../../common/colorThemeData.js';
import { colorThemeSchemaId, registerColorThemeSchemas } from '../../common/colorThemeSchema.js';
import { Extensions as JSONExtensions, type IJSONContributionRegistry } from '../../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IUserThemeService } from '../../../../common/userThemes.js';
import { WorkbenchProductIconThemesRegistry } from '../../common/themeExtensionPoints.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';

const jsonRegistry = Registry.as<IJSONContributionRegistry>(JSONExtensions.JSONContribution);

test('selected product icon theme refreshes mounted SVGs and returns to defaults', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => { }, removeEventListener: () => { } }) });
		const icon = registerIcon('test-workbench-product-icon', () => '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>', 'Workbench product icon test');
		using registration = WorkbenchProductIconThemesRegistry.registerThemes();
		registration.replace([{ id: 'test-workbench-svg', label: 'Test SVG', icons: new Map([[icon.id, () => '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>']]) }]);
		using configuration = new WorkbenchConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using active = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		active.initialize();
		const mounted = appendIcon(icon, browser.window.document.body);
		assert(mounted.querySelector('path'));
		await configuration.updateValue(WorkbenchConfiguration.productIconTheme, 'test-workbench-svg');
		assert.equal(active.getProductIconTheme().id, 'test-workbench-svg');
		assert(mounted.querySelector('circle'));
		await configuration.updateValue(WorkbenchConfiguration.productIconTheme, 'default');
		assert.equal(active.getProductIconTheme().id, 'default');
		assert(mounted.querySelector('path'));
		await configuration.updateValue(WorkbenchConfiguration.productIconTheme, 'test-workbench-svg');
		registration.replace([]);
		assert.equal(active.getProductIconTheme().id, 'default');
		assert(mounted.querySelector('path'));
		assert.equal(browser.window.document.body.querySelector('svg.ash-icon'), mounted);
	} finally {
		browser.window.close();
	}
});

const document = {
	name: 'Test User Aurora',
	type: 'dark',
	colors: { 'editor.background': '#101525', 'unsupported.extension.color': '#abcdef' },
	tokenColors: [{ scope: 'comment, string.quoted', settings: { foreground: '#123456', fontStyle: 'italic bold' } }],
};

test('persisted color customizations override themes, update live, and restore themed colors when removed', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => { }, removeEventListener: () => { } }) });
		const theme = parseUserColorTheme(JSON.stringify({ ...document, colors: { 'editor.selectionBackground': '#123456', 'editor.selectionForeground': '#abcdef' } }), 'selection-colors');
		using registration = WorkbenchThemesRegistry.registerColorThemes([theme]);
		using configuration = new WorkbenchConfigurationService({
			initialSnapshot: {
				revision: 1,
				document: { version: 1, source: `// user colors\n${JSON.stringify({ 'workbench.colorTheme': theme.id, 'workbench.colorCustomizations': { 'editor.selectionBackground': '#456789', 'editor.selectionForeground': '#112233' } })}` },
			}
		});
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using active = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		active.initialize();
		assert.deepEqual([
			active.getColorTheme().getColorCss('editor.selectionBackground'),
			active.getColorTheme().getColorCss('editor.selectionForeground'),
			active.getColorTheme().getColor('editor.inactiveSelectionBackground')?.rgba.a,
			active.getColorTheme().tokenColors,
		], ['#456789', '#112233', 0.65, theme.tokenColors]);
		assert.equal(active.getColorTheme().getColor('editor.inactiveSelectionBackground')?.rgba.r, 69);
		await configuration.updateValue(WorkbenchConfiguration.colorCustomizations, { 'editor.inactiveSelectionBackground': '#765432' });
		assert.equal(browser.window.document.body.style.getPropertyValue('--ash-editor-inactive-selection-background'), '#765432');
		assert.equal(active.getColorTheme().getColorCss('editor.selectionForeground'), '#abcdef');
		await configuration.updateValue(WorkbenchConfiguration.colorCustomizations, undefined);
		assert.equal(active.getColorTheme(), theme);
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light');
		assert.equal(active.getColorTheme().getColor('editor.selectionForeground'), undefined);
		for (const invalid of [[], null, { 'editor.selectionBackground': 'blue' }, { 'editor.selectionForeground': '#12345' }, { 'bad color': '#ffffff' }]) {
			await assert.rejects(configuration.updateValue(WorkbenchConfiguration.colorCustomizations, invalid));
		}
		assert.deepEqual(configuration.getValue(WorkbenchConfiguration.colorCustomizations), {});
	} finally {
		browser.window.close();
	}
});

test('user and extension themes share colors and TextMate rules', () => {
	const source = `// authored theme\n${JSON.stringify(document).replace(/}$/, ',}')}`;
	const user = parseUserColorTheme(source, 'test-user-aurora');
	const extension = createExtensionWorkbenchColorTheme(parseExtensionTheme(document, 'test-extension', 'test.theme', document.name, 'vs-dark', 'test'));
	assert.deepEqual(user.colors, extension.colors);
	assert.deepEqual(projectColorThemeTokens(user, 1), projectColorThemeTokens(extension, 1));
	assert.deepEqual(projectColorThemeTokens(user, 1).rules, [
		{ selector: 'comment, string.quoted', foreground: '#123456', fontStyle: ['italic', 'bold'] },
	]);
});

test('user and extension themes preserve semantic token selectors and styles', () => {
	const semantic = {
		...document,
		semanticHighlighting: true,
		semanticTokenColors: {
			'*': '#112233',
			'function.declaration:typescript': { foreground: '#abcdef', bold: true, italic: true },
			'variable.readonly': { bold: false },
		},
	};
	const user = parseUserColorTheme(JSON.stringify(semantic), 'test-semantic-user');
	const extension = createExtensionWorkbenchColorTheme(parseExtensionTheme(semantic, 'test-semantic-extension', 'test.theme', semantic.name, 'vs-dark', 'test'));
	assert.deepEqual(user.semanticTokenRules, extension.semanticTokenRules);
	assert.deepEqual(user.semanticTokenRules, [
		{ selector: '*', type: '*', modifiers: [], foreground: '#112233' },
		{ selector: 'function.declaration:typescript', type: 'function', modifiers: ['declaration'], language: 'typescript', foreground: '#abcdef', bold: true, italic: true },
		{ selector: 'variable.readonly', type: 'variable', modifiers: ['readonly'], bold: false },
	]);
	assert.equal(JSON.parse(serializeUserColorThemeDraft(user, user.label)).semanticTokenColors['function.declaration:typescript'].foreground, '#abcdef');
	assert.throws(() => parseUserColorTheme(JSON.stringify({ semanticTokenColors: { 'function[unsafe]': '#ffffff' } })), /Invalid semantic token selector/);
});

test('active semantic theme styles follow the selected theme', async () => {
	const browser = new JSDOM('<!doctype html><body><div class="stanza-editor"><span class="stanza-editor-token" data-ash-semantic-type="function" data-ash-semantic-modifiers="declaration" data-ash-semantic-language="typescript">call</span></div></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => { }, removeEventListener: () => { } }) });
		const theme = parseUserColorTheme(JSON.stringify({ name: 'Semantic', type: 'dark', semanticHighlighting: true, semanticTokenColors: { '*': '#112233', 'function.declaration:typescript': { foreground: '#abcdef', bold: true } } }), 'test-semantic-active');
		using registration = WorkbenchThemesRegistry.registerColorThemes([theme]);
		using configuration = new WorkbenchConfigurationService();
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, theme.id);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using active = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		active.initialize();
		const token = { startColumn: 1, endColumn: 5, type: 'function', modifiers: [] as const, semanticType: 'function', semanticModifiers: ['declaration'], semanticLanguage: 'typescript', syntaxPresentation: { foreground: '#123456', fontStyle: ['italic'] as const } };
		const presentation = () => resolveSemanticTokenPresentation(token, active.getColorTheme(), configuration.getValue('editor.semanticHighlighting.enabled') !== false && active.getColorTheme().semanticHighlighting === true);
		assert.deepEqual(presentation(), { foreground: '#abcdef', fontStyle: ['italic', 'bold'] });
		await configuration.updateValue('editor.semanticHighlighting.enabled', false);
		assert.deepEqual(presentation(), token.syntaxPresentation);
		await configuration.updateValue('editor.semanticHighlighting.enabled', true);
		assert.equal(presentation().foreground, '#abcdef');
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light');
		assert.deepEqual(presentation(), token.syntaxPresentation);
	} finally { browser.window.close(); }
});

test('user themes resolve colors across component domains and their dependent defaults', () => {
	const theme = parseUserColorTheme(JSON.stringify({
		name: 'Domain Color Overrides',
		type: 'dark',
		colors: {
			'list.hoverBackground': '#123456',
			'scrollbarSlider.background': '#234567',
			'scrollbarSlider.hoverBackground': '#345678',
			'scrollbarSlider.activeBackground': '#456789',
			'success.foreground': '#345678',
			'charts.orange': '#456789',
			'quickInput.background': '#56789a',
			'search.matchBackground': '#6789ab',
		},
	}));
	for (const [id, expected] of Object.entries({
		'menu.selectionBackground': '#123456',
		'button.hoverBackground': '#123456',
		'minimapSlider.background': '#234567',
		'minimapSlider.hoverBackground': '#345678',
		'minimapSlider.activeBackground': '#456789',
		'charts.green': '#345678',
		'charts.orange': '#456789',
		'quickInput.background': '#56789a',
		'search.matchBackground': '#6789ab',
	})) assert.equal(theme.getColorCss(id), expected, id);
});

test('theme exports contain standard fields and resolved colors', () => {
	const source = serializeUserColorThemeDraft(lightColorTheme, 'Test Light Copy');
	const exported = JSON.parse(source);
	assert.deepEqual(Object.keys(exported), ['$schema', 'name', 'type', 'colors', 'tokenColors']);
	assert.equal(exported.type, 'light');
	assert.deepEqual(parseUserColorTheme(source).colors, lightColorTheme.colors);
	using registration = registerColorThemeSchemas();
	assert.ok(jsonRegistry.getSchemaContributions().schemas[colorThemeSchemaId]?.properties?.colors?.properties?.['editor.background']);
});

test('active user themes apply overrides for colors registered after theme loading', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => { }, removeEventListener: () => { } }) });
		const theme = parseUserColorTheme(JSON.stringify({ ...document, colors: { 'editorCursor.foreground': '#aabbcc', 'test.workbenchLate': '#fedcba' } }), 'late-workbench-colors');
		using registration = WorkbenchThemesRegistry.registerColorThemes([theme]);
		using configuration = new WorkbenchConfigurationService();
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, theme.id);
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using active = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		active.initialize();
		const before = theme.colorEntries;
		const changes: string[] = [];
		using listener = active.onDidColorThemeChange(value => changes.push(value.getColorCss('test.workbenchLate')!));
		registerColor('test.workbenchLate', { dark: 'editorCursor.foreground', light: '#123456', highContrastDark: 'editorCursor.foreground', highContrastLight: '#000000' }, { description: 'Late workbench test.', owner: 'test' });
		assert.deepEqual({
			before: before.find(entry => entry.id === 'test.workbenchLate'),
			resolved: theme.colors['test.workbenchLate'],
			css: browser.window.document.body.style.getPropertyValue('--ash-test-workbench-late'),
			changes,
			tokenRules: theme.tokenColors,
		}, {
			before: undefined, resolved: '#fedcba', css: '#fedcba', changes: ['#fedcba'],
			tokenRules: [{ scopes: ['comment, string.quoted'], settings: { foreground: '#123456', fontStyle: 'italic bold' } }],
		});
		assert.equal(JSON.parse(serializeUserColorThemeDraft(theme, theme.label)).colors['test.workbenchLate'], '#fedcba');
		assert.ok(jsonRegistry.getSchemaContributions().schemas[colorThemeSchemaId]?.properties?.colors?.properties?.['test.workbenchLate']);
	} finally {
		browser.window.close();
	}
});

test('root theme extensions use the same document validator as user themes', async () => {
	const directory = join(process.cwd(), 'extensions/theme-defaults');
	const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	for (const contribution of manifest.contributes.themes) {
		const theme = await loadUserColorTheme(contribution.path, resource => readFile(join(directory, resource), 'utf8'), 'bundled-theme');
		assert.ok(theme.getColorCss('editor.background'));
	}
});

test('current theme documents reject retired fields, transforms, and invalid token styles', () => {
	for (const value of [
		{ ...document, version: 1 },
		{ ...document, id: 'custom' },
		{ ...document, colors: { 'editor.background': 'red' } },
		{ ...document, colors: { 'editor.background': { op: 'lighten', value: '#000000', factor: 0.2 } } },
		{ ...document, tokenColors: [{ scope: 'comment', settings: { fontStyle: 'blink' } }] },
	]) assert.throws(() => parseUserColorTheme(JSON.stringify(value)), /Invalid color theme/);
	assert.throws(() => parseUserColorTheme(JSON.stringify({ include: './base.json', colors: {} })), /resource loader/);
});

test('theme documents inherit colors and syntax rules in package order', async () => {
	const resources = new Map<string, unknown>([
		['themes/base.json', { colors: { 'editor.background': '#112233', 'statusBar.background': '#223344' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#334455' } }] }],
		['themes/child.json', { include: './base.json', colors: { 'editor.background': '#445566' }, tokenColors: [{ scope: 'string', settings: { foreground: '#556677' } }] }],
	]);
	const read = (path: string): unknown => resources.get(path);
	const resolved = resolveColorThemeDocument('themes/child.json', read);
	assert.deepEqual(resolved.colors, { 'editor.background': '#445566', 'statusBar.background': '#223344' });
	assert(Array.isArray(resolved.tokenColors));
	assert.deepEqual(resolved.tokenColors.map(rule => rule.scope), ['comment', 'string']);
	assert.deepEqual(await loadColorThemeDocument('themes/child.json', async path => read(path)), resolved);
	assert.throws(() => resolveColorThemeDocument('themes/child.json', path => path === 'themes/base.json' ? { include: './child.json' } : read(path)), /include cycle/);
	assert.throws(() => resolveColorThemeDocument('themes/child.json', path => path === 'themes/child.json' ? { include: '../../outside.json' } : read(path)), /escapes its package/);
});

test('theme documents load tokenColors from a TextMate theme resource', async () => {
	const syntax = '<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#123456</string></dict></dict></array></dict></plist>';
	const resources = new Map<string, unknown>([
		['themes/main.json', { colors: { 'editor.background': '#101010' }, tokenColors: './syntax.tmTheme' }],
		['themes/syntax.tmTheme', syntax],
	]);
	const resolved = resolveColorThemeDocument('themes/main.json', path => resources.get(path));
	assert(Array.isArray(resolved.tokenColors));
	assert.deepEqual(resolved.tokenColors.map(rule => rule.scope), ['comment']);
	assert.deepEqual(await loadColorThemeDocument('themes/main.json', async path => resources.get(path)), resolved);
	assert.throws(() => resolveColorThemeDocument('themes/main.json', path => path === 'themes/main.json' ? { tokenColors: '../../outside.tmTheme' } : resources.get(path)), /escapes its package/);
});

test('user theme reload applies included files from its theme directory', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-include-'));
	try {
		await mkdir(join(directory, 'shared'));
		await writeFile(join(directory, 'shared', 'base.json'), JSON.stringify({ colors: { 'statusBar.background': '#112233' } }));
		await writeFile(join(directory, 'custom.json'), JSON.stringify({ name: 'Custom', type: 'dark', include: './shared/base.json', colors: { 'editor.background': '#445566' } }));
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		using service = await loadThemes(files, directory);
		assert.equal(WorkbenchThemesRegistry.getColorTheme('custom')?.getColorCss('statusBar.background'), '#112233');
		await writeFile(join(directory, 'shared', 'base.json'), JSON.stringify({ colors: { 'statusBar.background': '#667788' } }));
		await service.reload();
		assert.equal(WorkbenchThemesRegistry.getColorTheme('custom')?.getColorCss('statusBar.background'), '#667788');
		assert.deepEqual(service.issues, []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('user theme loads a package-relative TextMate syntax file', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-textmate-'));
	try {
		await mkdir(join(directory, 'syntax'));
		await writeFile(join(directory, 'syntax', 'tokens.tmTheme'), '<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#abcdef</string></dict></dict></array></dict></plist>');
		await writeFile(join(directory, 'custom.json'), JSON.stringify({ name: 'Custom', type: 'dark', tokenColors: './syntax/tokens.tmTheme' }));
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		using service = await loadThemes(files, directory);
		assert.deepEqual(projectColorThemeTokens(WorkbenchThemesRegistry.getColorTheme('custom')!, 1).rules, [
			{ selector: 'string', foreground: '#abcdef' },
		]);
		assert.deepEqual(service.issues, []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('invalid external edits retain the last valid selected theme', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-external-edit-'));
	try {
		const path = join(directory, 'custom.json');
		await writeFile(path, JSON.stringify({ name: 'Custom', colors: { 'editor.background': '#112233' } }));
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		using service = await loadThemes(files, directory);
		const previous = WorkbenchThemesRegistry.getColorTheme('custom');
		await writeFile(path, '{');
		await service.reload();
		assert.equal(WorkbenchThemesRegistry.getColorTheme('custom'), previous);
		assert.deepEqual(service.issues.map(issue => issue.file), ['custom.json']);
		await writeFile(path, JSON.stringify({ name: 'Custom', colors: { 'editor.background': '#445566' } }));
		await service.reload();
		assert.equal(WorkbenchThemesRegistry.getColorTheme('custom')?.getColorCss('editor.background'), '#445566');
		assert.deepEqual(service.issues, []);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('theme file owner migrates aliases and transforms once before registration', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-migrate-'));
	try {
		const legacy = JSON.parse(await readFile(join(process.cwd(), 'src/ash/workbench/services/themes/test/browser/fixtures/resolver.json'), 'utf8'));
		await writeFile(join(directory, 'old-name.json'), JSON.stringify(legacy.theme));
		await writeFile(join(directory, 'broken.json'), '{');
		await writeFile(join(directory, 'ignored.txt'), 'keep');
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		const service = await loadThemes(files, directory);
		const first = await files.readDirectory(URI.file(directory));
		const migrated = await readFile(join(directory, 'resolver-test.json'), 'utf8');
		const theme = parseUserColorTheme(migrated, 'resolver-test');
		for (const [key, value] of Object.entries(legacy.expected)) assert.equal(theme.getColorCss(key), value, key);
		assert.equal(JSON.parse(migrated).version, undefined);
		assert.deepEqual(await files.readDirectory(URI.file(directory)), first);
		try {
			assert.equal(WorkbenchThemesRegistry.getColorTheme('resolver-test')?.label, 'Resolver Test');
			assert.deepEqual(service.issues.map(issue => issue.file), ['broken.json']);
		} finally { service.dispose(); }
		assert.equal(WorkbenchThemesRegistry.getColorTheme('resolver-test'), undefined);
		assert.deepEqual((await readdir(directory)).sort(), ['broken.json', 'ignored.txt', 'resolver-test.json']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('migration preserves conflicting targets and resumes after a durable equal target', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-conflict-'));
	try {
		const legacy = JSON.stringify({ version: 1, id: 'old-theme', label: 'Old Theme', colorScheme: 'dark', colors: { 'editor.background': '#123456' } });
		const source = join(directory, 'source.json');
		const target = join(directory, 'old-theme.json');
		await writeFile(source, legacy);
		await writeFile(target, JSON.stringify(document));
		using files = new DiskFileSystemProvider([URI.file(directory)]);
		const service = await loadThemes(files, directory);
		assert.match(service.issues.find(issue => issue.file === 'source.json')!.message, /conflicts/);
		service.dispose();
		assert.equal(await readFile(source, 'utf8'), legacy);
		assert.equal(await readFile(target, 'utf8'), JSON.stringify(document));
		await rm(target);
		(await loadThemes(files, directory)).dispose();
		const converted = await readFile(target, 'utf8');
		await writeFile(source, legacy);
		(await loadThemes(files, directory)).dispose();
		assert.equal((await files.readDirectory(URI.file(directory))).length, 1);
		assert.equal(await readFile(target, 'utf8'), converted);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('theme save, rename, reload, and delete keep identity in the filename', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-theme-save-'));
	using files = new DiskFileSystemProvider([URI.file(directory)]);
	const service = await loadThemes(files, directory);
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', {
			value: () => ({
				matches: false,
				addEventListener: () => { },
				removeEventListener: () => { },
			})
		});
		using configuration = new WorkbenchConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using activeThemes = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		activeThemes.initialize();
		const created = await service.saveAs(JSON.stringify(document));
		assert.equal(created.file, 'test-user-aurora.json');
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, created.theme.id);
		const replacement = JSON.stringify({ ...document, name: 'Renamed Theme', colors: { 'editor.background': '#202530' } });
		const saved = await service.save(created.theme.id, replacement);
		assert.equal(saved.theme.id, created.theme.id);
		assert.equal(saved.theme.label, 'Renamed Theme');
		assert.equal(saved.theme.getColorCss('editor.background'), '#202530');
		assert.equal(activeThemes.getColorTheme(), saved.theme);
		assert.equal(browser.window.document.body.style.getPropertyValue('--ash-editor-background'), '#202530');
		await service.reload();
		assert.equal(service.getSource(saved.theme.id), replacement);
		await service.delete(saved.theme.id);
		assert.equal(WorkbenchThemesRegistry.getColorTheme(saved.theme.id), undefined);
		assert.equal(activeThemes.getColorTheme(), WorkbenchThemesRegistry.getColorTheme('ash-light'));
		assert.deepEqual(await readdir(directory), []);
	} finally { service.dispose(); browser.window.close(); await rm(directory, { recursive: true, force: true }); }
});

async function loadThemes(files: IFileService, directory: string): Promise<IUserThemeService & IDisposable> {
	using services = new InstantiationService();
	services.registerInstance(IFileService, files);
	return loadUserThemes(services, URI.file(directory));
}

test('theme scoped customizations inherit global syntax and semantic styles and reset authored UI colors', async () => {
	const theme = parseUserColorTheme(JSON.stringify({
		name: 'Scoped Aurora', type: 'dark', colors: { 'editor.selectionBackground': '#123456' },
		tokenColors: [{ settings: { foreground: '#112233', fontStyle: 'italic bold' } }, { scope: 'entity.name.function', settings: { foreground: '#223344' } }],
	}), 'scoped-aurora');
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue('workbench.colorCustomizations', { 'editor.selectionForeground': '#445566', '[Scoped *]': { 'editor.selectionBackground': 'default' } });
	await configuration.updateValue('editor.tokenColorCustomizations', {
		textMateRules: [{ scope: 'entity.name.function', settings: { fontStyle: 'italic' } }],
		'[Scoped Aurora]': { textMateRules: [{ scope: 'entity.name.function', settings: { foreground: '#556677' } }] },
	});
	await configuration.updateValue('editor.semanticTokenColorCustomizations', {
		enabled: true, rules: { function: { foreground: '#778899', italic: false } },
		'[Scoped Aurora]': { rules: { function: { bold: false } } },
	});
	const { applyThemeCustomizations } = await import('../../common/themeConfiguration.js');
	const active = applyThemeCustomizations(theme, configuration);
	assert.deepEqual([
		active.defines('editor.selectionBackground'), active.getColor('editor.selectionBackground', false),
		active.getColorCss('editor.selectionForeground'), active.semanticHighlighting,
	], [false, undefined, '#445566', true]);
	const syntax = projectColorThemeTokens(active, 1);
	const { createTextMateScopeThemeResolver } = await import('../../../textMate/common/textMateScopeTheme.js');
	assert.deepEqual(createTextMateScopeThemeResolver(syntax)(['source.ts', 'entity.name.function.ts']), {
		tokenType: 'function', modifiers: [], foreground: '#556677', fontStyle: ['italic'],
	});
	const metadata = active.getTokenStyleMetadata('function', [], 'typescript')!;
	assert.deepEqual({ ...metadata, foreground: active.tokenColorMap[metadata.foreground!] }, { foreground: '#778899', bold: false, italic: false, underline: false, strikethrough: false });
	await configuration.updateValue('editor.semanticTokenColorCustomizations', {});
	const syntaxMapped = applyThemeCustomizations(theme, configuration).getTokenStyleMetadata('function', [], 'typescript')!;
	assert.equal(syntaxMapped.italic, true);
});

test('theme settings expose structured schemas and localized labels', async () => {
	const { Registry } = await import('../../../../../platform/registry/common/platform.js');
	const { Extensions, ConfigurationScope } = await import('../../../../../platform/configuration/common/configurationRegistry.js');
	const registry = Registry.as<import('../../../../../platform/configuration/common/configurationRegistry.js').IConfigurationRegistry>(Extensions.Configuration);
	const { createConfigurationSchema } = await import('../../../../../platform/configuration/common/configurationSchema.js');
	const { jsonSchemaAtPath } = await import('../../../../../base/common/jsonSchema.js');
	const schema = createConfigurationSchema();
	assert.equal(jsonSchemaAtPath(schema, ['workbench.colorCustomizations', '[Ash Dark]', 'editor.selectionBackground'])?.type, 'string');
	assert.equal(jsonSchemaAtPath(schema, ['editor.semanticTokenColorCustomizations', '[Ash Dark]', 'rules', 'function', 'bold'])?.type, 'boolean');
	assert.equal(registry.getConfiguration('window.autoDetectColorScheme')?.scope, ConfigurationScope.APPLICATION);
	using configuration = new WorkbenchConfigurationService();
	await assert.rejects(configuration.updateValue('workbench.colorCustomizations', {}, { overrideIdentifiers: ['typescript'] }), /language|Language/u);
	const { builtinLanguagePackCatalogs } = await import('../../../localization/common/localizationCatalogs.js');
	const { setNlsResolver, resetNlsResolver } = await import('../../../../../nls.js');
	const chinese = builtinLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, original) => chinese.bundles[bundle]?.[key] ?? original);
		assert.equal(registry.getConfiguration('editor.tokenColorCustomizations')?.setting?.title, '语法颜色');
		assert.equal(registry.getConfiguration('window.autoDetectHighContrast')?.setting?.title, '跟随系统高对比度');
	} finally { resetNlsResolver(); }
});

test('TextMate configuration retains grouped alternatives and global styles throughout theme compilation', async () => {
	const { applyThemeCustomizations } = await import('../../common/themeConfiguration.js');
	const { createTextMateScopeThemeResolver } = await import('../../../textMate/common/textMateScopeTheme.js');
	const theme = parseUserColorTheme(JSON.stringify({
		name: 'Grouped', tokenColors: [{ scope: 'source.ts (entity.name.function, variable.other)', settings: { foreground: '#112233' } }],
	}));
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue('editor.tokenColorCustomizations', {
		textMateRules: [{ settings: { fontStyle: 'italic' } }, { scope: 'source.ts (entity.name.function, variable.other)', settings: { foreground: '#445566' } }],
	});
	const active = applyThemeCustomizations(theme, configuration);
	const resolve = createTextMateScopeThemeResolver(projectColorThemeTokens(active, 1));
	assert.deepEqual(resolve(['source.ts', 'entity.name.function.ts']), { tokenType: 'function', modifiers: [], foreground: '#445566', fontStyle: ['italic'] });
	assert.deepEqual(resolve(['source.ts', 'variable.other.ts']), { tokenType: 'variable', modifiers: [], foreground: '#445566', fontStyle: ['italic'] });
});

test('individual semantic flags override shorthand fontStyle even when false', () => {
	const theme = parseUserColorTheme(JSON.stringify({
		name: 'Semantic flags', semanticTokenColors: {
			function: { foreground: '#123456', fontStyle: 'bold italic', bold: false, italic: false, underline: true },
		},
	}));
	const metadata = theme.getTokenStyleMetadata('function', [], 'typescript')!;
	assert.deepEqual({ ...metadata, foreground: theme.tokenColorMap[metadata.foreground!] }, {
		foreground: '#123456', bold: false, italic: false, underline: true, strikethrough: false,
	});
});
