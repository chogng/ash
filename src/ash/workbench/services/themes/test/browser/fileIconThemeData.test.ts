import { createTestEditorServices } from '../../../../test/common/testEditorServices.js';
import { IResourceIconRenderer } from '../../../../browser/labels.js';
import { Event } from '../../../../../base/common/event.js';
import { IFileTextModelService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { EditorTitleControl } from '../../../../browser/parts/editor/editorTitleControl.js';
import { EditorGroupModel } from '../../../../common/editor/editorGroupModel.js';
import { createDiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { EditorShowIconsConfiguration, EditorTabsModeConfiguration } from '../../../editor/common/editorConfiguration.js';
import type { EditorTabsDelegate } from '../../../../browser/parts/editor/editorTabsControl.js';
import { IHostColorSchemeService } from '../../common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../../browser/browserHostColorSchemeService.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
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
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { FileIconThemeData } from '../../browser/fileIconThemeData.js';
import { WorkbenchThemeService } from '../../browser/workbenchThemeService.js';

const directory = 'extensions/theme-seti/icons/';

test('packaged Seti resolves filenames, extensions and light variants and can be disabled', async () => {
	const document = JSON.parse(await readFile(directory + 'vs-seti-icon-theme.json', 'utf8'));
	const theme = await FileIconThemeData.load('vs-seti', 'Seti', document, path => readFile(directory + path));
	using registration = WorkbenchFileIconThemesRegistry.registerThemes();
	registration.replace([theme]);
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() { }, removeEventListener() { } }) });
		using configuration = new WorkbenchConfigurationService();
		using services = new InstantiationService();
		services.registerInstance(IConfigurationService, configuration);
		using languages = new LanguageService();
		using typescript = languages.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
		using rust = languages.registerLanguage({ id: 'rust', extensions: ['.rs'] });
		services.registerInstance(ILanguageService, languages);
		using hostColors = new BrowserHostColorSchemeService(browser.window as unknown as Window);
		services.registerInstance(IHostColorSchemeService, hostColors);
		using models = new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: request.bootstrapText ?? '', revision: undefined }), save: async () => ({ revision: undefined }) }, { languageService: languages });
		services.registerInstance(IFileTextModelService, models);
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
		using labels = new ResourceLabels(DEFAULT_LABELS_CONTAINER, { workspaceContextService: workspace, resourceIconRenderer: themes, fileModels: models, languageService: languages });
		const label = labels.create(browser.window.document.body);
		label.setFile(URI.file('C:/project/source.custom'));
		services.registerInstance(IResourceIconRenderer, themes);
		using editorServices = createTestEditorServices(configuration, services, browser.window.document);
		const group = new EditorGroupModel();
		const input = { resource: URI.file('C:/project/main.ts') };
		group.openEditor(input);
		const delegate: EditorTabsDelegate = { activate() { }, preview() { }, close() { }, pinEditor() { }, unstickEditor() { }, startDrag() { }, isDragging: () => false, drop() { }, dropExternal() { }, endDrag() { } };
		using title = editorServices.createInstance(EditorTitleControl, browser.window.document.body, delegate, group, undefined, configuration, undefined, undefined, undefined, undefined, undefined);
		const editors = [{ instanceId: 'main', input, panelId: 'main-panel', tabId: 'main-tab' }];
		title.setEditors(editors, input);
		const tab = title.domNode.querySelector<HTMLButtonElement>('[role="tab"]')!;
		const tabIcon = tab.querySelector<HTMLElement>('.ash-icon-label-icon')!;
		assert.equal(tabIcon.textContent, render('main.ts').textContent);
		assert.equal(tabIcon.getAttribute('aria-hidden'), 'true');
		tab.focus();
		await configuration.updateValue(EditorShowIconsConfiguration, false);
		assert.equal(tabIcon.textContent, '');
		assert.equal(tabIcon.classList.contains('is-reserved'), false);
		await configuration.updateValue(EditorShowIconsConfiguration, true);
		assert.notEqual(tabIcon.textContent, '');
		assert.equal(browser.window.document.activeElement, tab);
		const tabColor = tabIcon.style.color;
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
		assert.notEqual(tabIcon.style.color, tabColor);
		assert.equal(browser.window.document.activeElement, tab);
		await configuration.updateValue(EditorTabsModeConfiguration, 'single');
		assert.notEqual(title.domNode.querySelector('.ash-icon-label-icon')?.textContent, '');
		await configuration.updateValue(EditorTabsModeConfiguration, 'multiple');
		const comparison = createDiffEditorInput({ resource: URI.file('/project/old.rs') }, { resource: URI.parse('git-change:/unstaged/main.test.ts?revision=1') }, 'Renamed test');
		const comparisons = [{ instanceId: 'comparison', input: comparison, panelId: 'comparison-panel', tabId: 'comparison-tab' }];
		group.closeEditor(input);
		group.openEditor(comparison);
		title.setEditors(comparisons, comparison);
		const assertComparisonIcon = (): void => {
			const comparisonTab = title.domNode.querySelector<HTMLElement>('[role="tab"]')!;
			const comparisonIcon = comparisonTab.querySelector<HTMLElement>('.ash-icon-label-icon')!;
			assert.deepEqual([comparisonIcon.textContent, comparisonIcon.style.color], [render('main.test.ts').textContent, render('main.test.ts').style.color]);
			assert(comparisonIcon.classList.contains('typescript-lang-file-icon'));
			assert.equal(comparisonIcon.classList.contains('rust-lang-file-icon'), false);
			assert.equal(comparisonIcon.getAttribute('aria-hidden'), 'true');
			assert.equal(comparisonTab.id, 'comparison-tab');
			assert.equal(comparisonTab.getAttribute('aria-controls'), 'comparison-panel');
		};
		assertComparisonIcon();
		await configuration.updateValue(EditorTabsModeConfiguration, 'single');
		assertComparisonIcon();
		await configuration.updateValue(EditorTabsModeConfiguration, 'multiple');
		assertComparisonIcon();
		group.closeEditor(comparison);
		group.openEditor(input);
		title.setEditors(editors, input);
		group.stick(input);
		title.setEditors([{ ...editors[0]!, sticky: true }], input);
		assert.notEqual(title.domNode.querySelector('.ash-sticky-editor-tabs-row .ash-icon-label-icon')?.textContent, '');
		const labelIcon = label.element.querySelector('.ash-icon-label-icon');
		const beforeRegistration = labelIcon?.textContent;
		using custom = languages.registerLanguage({ id: 'javascript', extensions: ['.custom'] });
		assert.equal(iconChanges, 2);
		assert.notEqual(labelIcon?.textContent, beforeRegistration);
		assert.equal(labelIcon?.classList.contains('javascript-lang-file-icon'), true);
		const modelInput = { resource: URI.file('/project/no-extension'), languageId: 'typescript' };
		const modelReference = await models.acquire(modelInput, new AbortController().signal);
		const modelLabel = labels.create(browser.window.document.body);
		modelLabel.setFile(modelInput.resource);
		const modelIcon = modelLabel.element.querySelector<HTMLElement>('.ash-icon-label-icon')!;
		assert(modelIcon.classList.contains('typescript-lang-file-icon'));
		const beforeLanguageChange = modelIcon.textContent;
		modelReference.model.setLanguage(languages.createById('javascript'));
		assert(modelIcon.classList.contains('javascript-lang-file-icon'));
		assert.notEqual(modelIcon.textContent, beforeLanguageChange);
		modelReference.dispose();
		assert.equal(modelIcon.classList.contains('javascript-lang-file-icon'), false);
		const untitledInput = { resource: URI.parse('untitled:/Untitled-1'), languageId: 'rust' };
		using untitledReference = await models.acquire(untitledInput, new AbortController().signal);
		modelLabel.setFile(untitledInput.resource);
		assert(modelIcon.classList.contains('rust-lang-file-icon'));
		let themeStateChanges = 0;
		using themeStateListener = themes.onDidFileIconThemeChange(state => { themeStateChanges++; assert.equal(state, themes.getFileIconTheme()); });
		assert.equal(themes.getFileIconTheme().hasFileIcons, true);
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, null);
		themes.renderFileIcon(URI.file('C:/project/main.ts'), ts);
		assert.deepEqual([ts.textContent, ts.style.fontFamily, ts.style.color], ['', '', '']);
		assert.equal(browser.window.document.head.textContent, '');
		assert.equal(themes.getFileIconTheme().hasFileIcons, false);
		assert.equal(modelIcon.classList.contains('is-reserved'), false);
		assert.equal(title.domNode.querySelector('.ash-sticky-editor-tabs-row .ash-icon-label-icon')?.textContent, '');
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, 'vs-seti');
		assert.notEqual(render('main.ts').textContent, '');
		assert.equal(themeStateChanges, 2);
		modelLabel.dispose();
		title.dispose();
		assert.equal(labels.get(1), undefined);
		editorServices.dispose();
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
	await assert.rejects(FileIconThemeData.load('bad', 'Bad', { iconDefinitions: {}, hidesExplorerArrows: 'yes' }, read), /must be a boolean/);
});

test('folder completion classes resolve folder theme associations', async () => {
	const theme = await FileIconThemeData.load('folders', 'Folders', {
		iconDefinitions: {
			folder: { iconPath: 'folder.svg' },
			src: { iconPath: 'src.svg' },
			lightSrc: { iconPath: 'light-src.svg' },
		},
		folder: 'folder',
		hidesExplorerArrows: true,
		folderNames: { src: 'src' },
		light: { folderNames: { src: 'lightSrc' } },
	}, async path => new TextEncoder().encode(path));
	assert.deepEqual([theme.hasFileIcons, theme.hasFolderIcons, theme.hidesExplorerArrows], [false, true, true]);
	const fallback = theme.resolveFileIcon(['folder-icon'], ColorScheme.Dark);
	const dark = theme.resolveFileIcon(['folder-icon', 'src-name-folder-icon'], ColorScheme.Dark);
	const light = theme.resolveFileIcon(['folder-icon', 'src-name-folder-icon'], ColorScheme.Light);
	assert.notEqual(dark?.image, fallback?.image);
	assert.notEqual(light?.image, dark?.image);
	assert.match(theme.styleSheetContent, /ash-themed-file-icon\.folder-icon\[class~="src-name-folder-icon"\]/);
});

test('high contrast file associations and font descriptors reach resource and suggestion renderers', async () => {
	const theme = await FileIconThemeData.load('contrast-font', 'Contrast font', {
		fonts: [{ id: 'icons', weight: '700', style: 'italic', src: [{ path: 'icons.woff', format: 'woff' }] }],
		iconDefinitions: { normal: { fontCharacter: 'N' }, contrast: { fontCharacter: 'H', fontColor: '#ffffff' } },
		file: 'normal',
		highContrast: { fileExtensions: { ts: 'contrast' } },
	}, async () => new Uint8Array([1]));
	const classes = ['file-icon', 'ts-ext-file-icon'];
	assert.equal(theme.resolveFileIcon(classes, ColorScheme.Dark)?.character, 'N');
	for (const scheme of [ColorScheme.HighContrastDark, ColorScheme.HighContrastLight]) {
		const icon = theme.resolveFileIcon(classes, scheme)!;
		assert.deepEqual([icon.character, icon.fontWeight, icon.fontStyle], ['H', '700', 'italic']);
	}
	assert.match(theme.styleSheetContent, /font-weight:700;font-style:italic/);
	assert.match(theme.styleSheetContent, /data-color-scheme="high-contrast-dark"/);
	await assert.rejects(FileIconThemeData.load('invalid-font', 'Invalid font', {
		fonts: [{ id: 'icons', weight: 'heavy', src: [{ path: 'icons.woff', format: 'woff' }] }], iconDefinitions: {},
	}, async () => new Uint8Array([1])), /weight or style/);
});
