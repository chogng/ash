import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../../browser/labels.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { FileIconThemeData } from '../../browser/fileIconThemeData.js';
import { WorkbenchThemeService } from '../../browser/workbenchThemeService.js';

const directory = '../extensions/theme-seti/icons/';

test('packaged Seti resolves filenames, extensions and light variants and can be disabled', async () => {
	const document = JSON.parse(await readFile(directory + 'vs-seti-icon-theme.json', 'utf8'));
	const theme = await FileIconThemeData.load('vs-seti', 'Seti', document, path => readFile(directory + path));
	using registration = WorkbenchFileIconThemesRegistry.registerThemes();
	registration.replace([theme]);
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
		using configuration = new WorkbenchConfigurationService();
		using services = new ServiceContainer();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		using typescript = languages.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
		using rust = languages.registerLanguage({ id: 'rust', extensions: ['.rs'] });
		services.registerInstance(ILanguageService, languages);
		using themes = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		themes.initialize();
		const render = (name: string): HTMLElement => {
			const icon = browser.window.document.createElement('span');
			themes.renderFileIcon(URI.file('C:/project/' + name), icon);
			return icon;
		};
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
		const ts = render('main.ts');
		assert.equal(ts.classList.contains('typescript-lang-file-icon'), true);
		assert.equal(ts.classList.contains('ts-ext-file-icon'), true);
		assert.notEqual(render('README.md').textContent, '');
		assert.notEqual(ts.textContent, render('source.unknown-extension').textContent);
		assert.notEqual(render('source.rs').textContent, render('source.unknown-extension').textContent);
		assert.notEqual(ts.style.color, render('main.test.ts').style.color);
		assert.match(browser.window.document.head.textContent!, /data:application\/octet-stream;base64,/);
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light');
		assert.notEqual(render('main.ts').style.color, ts.style.color);
		let iconChanges = 0;
		using iconListener = themes.onDidChangeResourceIcons(() => iconChanges++);
		using workspace = new WorkspaceContextService({ id: 'workspace', uri: URI.file('C:/project') });
		using labels = new ResourceLabels(DEFAULT_LABELS_CONTAINER, { workspaceContextService: workspace, resourceIconRenderer: themes });
		const label = labels.create(browser.window.document.body);
		label.setFile(URI.file('C:/project/source.custom'));
		const labelIcon = label.element.querySelector('.ash-icon-label-icon');
		const beforeRegistration = labelIcon?.textContent;
		using custom = languages.registerLanguage({ id: 'javascript', extensions: ['.custom'] });
		assert.equal(iconChanges, 1);
		assert.notEqual(labelIcon?.textContent, beforeRegistration);
		assert.equal(labelIcon?.classList.contains('javascript-lang-file-icon'), true);
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, null);
		themes.renderFileIcon(URI.file('C:/project/main.ts'), ts);
		assert.deepEqual([ts.textContent, ts.style.fontFamily, ts.style.color], ['', '', '']);
		assert.equal(browser.window.document.head.textContent, '');
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, 'vs-seti');
		assert.notEqual(render('main.ts').textContent, '');
		themes.dispose();
		assert.equal(browser.window.document.head.querySelector('style'), null);
	} finally { browser.window.close(); }
});

test('icon documents reject escaping assets and missing definitions before activation', async () => {
	let reads = 0;
	const read = async (): Promise<Uint8Array> => { reads++; return new Uint8Array(); };
	await assert.rejects(FileIconThemeData.load('bad', 'Bad', { fonts: [{ id: 'font', src: [{ path: '../outside.woff', format: 'woff' }] }], iconDefinitions: {} }, read), /inside/);
	assert.equal(reads, 0);
	await assert.rejects(FileIconThemeData.load('bad', 'Bad', { iconDefinitions: {}, file: 'absent' }, read), /Unknown file icon/);
});

test('folder completion classes resolve folder theme associations', async () => {
	const theme = await FileIconThemeData.load('folders', 'Folders', {
		iconDefinitions: {
			folder: { iconPath: 'folder.svg' },
			src: { iconPath: 'src.svg' },
			lightSrc: { iconPath: 'light-src.svg' },
		},
		folder: 'folder',
		folderNames: { src: 'src' },
		light: { folderNames: { src: 'lightSrc' } },
	}, async path => new TextEncoder().encode(path));
	const fallback = theme.resolveFileIcon(['folder-icon'], true);
	const dark = theme.resolveFileIcon(['folder-icon', 'src-name-folder-icon'], true);
	const light = theme.resolveFileIcon(['folder-icon', 'src-name-folder-icon'], false);
	assert.notEqual(dark?.image, fallback?.image);
	assert.notEqual(light?.image, dark?.image);
	assert.match(theme.styleSheetContent, /ash-themed-file-icon\.folder-icon\[class~="src-name-folder-icon"\]/);
});
