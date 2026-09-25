import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { lightColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../../base/common/uri.js';
import { WorkbenchThemesRegistry } from '../../../../common/theme.js';
import { loadUserThemes, WorkbenchThemeService } from '../../browser/workbenchThemeService.js';
import { createExtensionWorkbenchColorTheme, parseExtensionTheme } from '../../../extensions/common/extensionTheme.js';
import { projectColorThemeTokens } from '../../../textMate/common/textMateThemeProjection.js';
import { parseUserColorTheme, serializeUserColorThemeDraft } from '../../common/colorThemeData.js';
import { colorThemeSchemaId, registerColorThemeSchemas } from '../../common/colorThemeSchema.js';
import { JsonSchemasRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IUserThemeService } from '../../../../common/userThemes.js';
import { WorkbenchProductIconThemesRegistry } from '../../common/themeExtensionPoints.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';

test('selected product icon theme refreshes mounted SVGs and returns to defaults', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
		const icon = registerIcon('test-workbench-product-icon', () => '<svg viewBox="0 0 16 16"><path d="M1 1"/></svg>', 'Workbench product icon test');
		using registration = WorkbenchProductIconThemesRegistry.registerThemes();
		registration.replace([{ id: 'test-workbench-svg', label: 'Test SVG', icons: new Map([[icon.id, () => '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4"/></svg>']]) }]);
		using configuration = new WorkbenchConfigurationService();
		using services = new ServiceContainer();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
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

test('user and extension themes share colors and TextMate rules', () => {
	const source = `// authored theme\n${JSON.stringify(document).replace(/}$/, ',}')}`;
	const user = parseUserColorTheme(source, 'test-user-aurora');
	const extension = createExtensionWorkbenchColorTheme(parseExtensionTheme(document, 'test-extension', 'test.theme', document.name, 'vs-dark', 'test'));
	assert.deepEqual(user.colors, extension.colors);
	assert.deepEqual(projectColorThemeTokens(user, 1), projectColorThemeTokens(extension, 1));
	assert.deepEqual(projectColorThemeTokens(user, 1).rules, [
		{ selector: 'comment', foreground: '#123456', fontStyle: ['italic', 'bold'] },
		{ selector: 'string.quoted', foreground: '#123456', fontStyle: ['italic', 'bold'] },
	]);
});

test('user themes resolve colors across component domains and their dependent defaults', () => {
	const theme = parseUserColorTheme(JSON.stringify({
		name: 'Domain Color Overrides',
		type: 'dark',
		colors: {
			'list.hoverBackground': '#123456',
			'scrollbar.sliderBackground': '#234567',
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
	assert.ok(JsonSchemasRegistry.getSchema(colorThemeSchemaId)?.properties?.colors?.properties?.['editor.background']);
});

test('active user themes refresh later colors while preserving editor overrides and token rules', async () => {
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
		const theme = parseUserColorTheme(JSON.stringify({ ...document, colors: { 'editorCursor.foreground': '#aabbcc' } }), 'late-workbench-colors');
		using registration = WorkbenchThemesRegistry.registerColorThemes([theme]);
		using configuration = new WorkbenchConfigurationService();
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, theme.id);
		using services = new ServiceContainer();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
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
			before: undefined, resolved: '#aabbcc', css: '#aabbcc', changes: ['#aabbcc'],
			tokenRules: [{ scopes: ['comment', 'string.quoted'], settings: { foreground: '#123456', fontStyle: 'italic bold' } }],
		});
		assert.equal(JSON.parse(serializeUserColorThemeDraft(theme, theme.label)).colors['test.workbenchLate'], '#aabbcc');
		assert.ok(JsonSchemasRegistry.getSchema(colorThemeSchemaId)?.properties?.colors?.properties?.['test.workbenchLate']);
	} finally {
		browser.window.close();
	}
});

test('root theme extensions use the same document validator as user themes', async () => {
	const directory = join(process.cwd(), '../extensions/theme-defaults');
	const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	for (const contribution of manifest.contributes.themes) {
		const source = await readFile(join(directory, contribution.path), 'utf8');
		assert.ok(parseUserColorTheme(source, 'bundled-theme').getColorCss('editor.background'));
	}
});

test('current theme documents reject retired fields, transforms, and invalid token styles', () => {
	for (const value of [
		{ ...document, version: 1 },
		{ ...document, id: 'custom' },
		{ ...document, colors: { 'editor.background': 'red' } },
		{ ...document, colors: { 'editor.background': { op: 'lighten', value: '#000000', factor: 0.2 } } },
		{ ...document, tokenColors: [{ scope: 'comment', settings: { fontStyle: 'blink' } }] },
		{ ...document, include: './other.json' },
	]) assert.throws(() => parseUserColorTheme(JSON.stringify(value)), /Invalid color theme/);
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
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		}) });
		using configuration = new WorkbenchConfigurationService();
		using services = new ServiceContainer();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		services.registerInstance(ILanguageService, languages);
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
		assert.equal(activeThemes.getColorTheme(), lightColorTheme);
		assert.deepEqual(await readdir(directory), []);
	} finally { service.dispose(); browser.window.close(); await rm(directory, { recursive: true, force: true }); }
});

async function loadThemes(files: IFileService, directory: string): Promise<IUserThemeService & IDisposable> {
	using services = new ServiceContainer();
	services.registerInstance(IFileService, files);
	return loadUserThemes(services, URI.file(directory));
}
