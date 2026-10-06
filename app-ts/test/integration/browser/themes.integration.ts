import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBrowserExtensionApi } from '../../../src/ash/platform/extensions/browser/extensionApi.js';
import '../../../src/ash/workbench/browser/parts/notifications/media/notifications.css';
import { IHostColorSchemeService } from '../../../src/ash/workbench/services/themes/common/hostColorSchemeService.js';
import { BrowserHostColorSchemeService } from '../../../src/ash/workbench/services/themes/browser/browserHostColorSchemeService.js';
import type { TextModelReference } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import '../../../src/ash/base/browser/ui/iconlabel/iconlabel.css';
import { Event } from '../../../src/ash/base/common/event.js';
import { Emitter } from '../../../src/ash/base/common/event.js';
import { NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { DecorationsService } from '../../../src/ash/workbench/services/decorations/browser/decorationsService.js';
import type { IDecorationData } from '../../../src/ash/workbench/services/decorations/common/decorations.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels } from '../../../src/ash/workbench/browser/labels.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import manifest from '../../../../extensions/theme-seti/package.json' with { type: 'json' };
import themeUrl from '../../../../extensions/theme-seti/icons/vs-seti-icon-theme.json?url';
import fontUrl from '../../../../extensions/theme-seti/icons/seti.woff?url';
import productThemeUrl from './fixtures/product-icons/theme.json?url';
import productIconUrl from './fixtures/product-icons/add.svg?url';
import '../../../src/ash/workbench/browser/media/style.css';
import '../../../src/ash/base/browser/ui/contextview/contextview.css';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/menu/menu.css';
import '../../../src/ash/base/browser/ui/selectbox/selectbox.css';
import '../../../src/ash/base/browser/ui/scrollbar/scrollbar.css';
import '../../../src/ash/base/browser/ui/tree/tree.css';
import '../../../src/ash/base/browser/ui/list/list.css';
import '../../../src/ash/editor/browser/widget/richTextEditor/richTextEditorWidget.css';
import '../../../src/ash/platform/actionWidget/browser/actionWidget.css';
import '../../../src/ash/sessions/browser/parts/titlebar/media/titlebarpart.css';
import '../../../src/ash/workbench/browser/parts/editor/media/modalEditorPart.css';
import '../../../src/ash/workbench/contrib/pdf/browser/media/pdfEditor.css';
import '../../../src/ash/workbench/contrib/scm/browser/media/scm.css';
import '../../../src/ash/sessions/common/theme.js';
import '../../../src/ash/workbench/contrib/pdf/common/pdfColors.js';
import { appendIcon } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { IconSelectBox } from '../../../src/ash/base/browser/ui/icons/iconSelectBox.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { ILanguageService } from '../../../src/ash/editor/common/languages/language.js';
import { LanguageService } from '../../../src/ash/editor/common/services/languageService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { WorkbenchConfiguration } from '../../../src/ash/workbench/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { WorkbenchThemeService } from '../../../src/ash/workbench/services/themes/browser/workbenchThemeService.js';
import { TextMateGrammarService } from '../../../src/ash/workbench/services/textMate/common/textMateGrammarService.js';
import type { ITextMateService } from '../../../src/ash/workbench/services/textMate/common/textMateService.js';
import { createTextMateSyntaxWorkerFactory } from '../../../src/ash/workbench/services/textMate/browser/textMateSyntaxWorkerClient.js';
import { TextMateGrammarCatalogModel } from '../../../src/ash/workbench/services/textMate/common/textMateGrammarCatalog.js';
import { TextMateScopeThemeModel } from '../../../src/ash/workbench/services/textMate/common/textMateScopeTheme.js';
import { LanguageRequestCoordinator } from '../../../src/ash/editor/common/model/languageRequestCoordinator.js';
import type { LanguageToken } from '../../../src/ash/editor/common/tokens/languageTokens.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { registerColor } from '../../../src/ash/platform/theme/common/colorUtils.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { registerIcon } from '../../../src/ash/platform/theme/common/iconRegistry.js';

declare global {
	interface Window {
		changeIconModelLanguage(id: string): void;
		releaseIconModels(): void;
		disposeIconLabels(): void;
		registerLateThemeColor(): void;
		disposeThemeRoot(): void;
		selectColorTheme(id: string): Promise<void>;
		setThemeSetting(key: string, value: unknown): Promise<void>;
		disposeThemeExtensions(): void;
		mountNestedHighContrastWidget(): void;
		disposeNestedHighContrastWidget(): void;
		disposeIconSelectBox(): void;
		previewInTextMateWorker(): Promise<{ preview: string[]; unchanged: boolean; text: string; }>;
		tokenizeInTextMateWorker(): Promise<readonly { type: string; modifiers: readonly string[]; presentation?: { foreground?: string; fontStyle?: readonly string[]; }; }[]>;
		setLabelDecoration(data: IDecorationData | undefined): void;
		removeLabelDecorationProvider(): void;
	}
}

window.tokenizeInTextMateWorker = async () => {
	using catalogs = new TextMateGrammarCatalogModel({
		revision: 1,
		grammars: [{
			scopeName: 'source.demo',
			languageId: 'demo',
			injectTo: [],
			content: JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '\\bif\\b', name: 'keyword.control.demo' }] }),
		}],
	});
	using scopeTheme = new TextMateScopeThemeModel();
	using model = new TextModel('if');
	using syntax = new LanguageRequestCoordinator(model, createTextMateSyntaxWorkerFactory(catalogs, scopeTheme));
	const results: { type: string; modifiers: readonly string[]; presentation?: { foreground?: string; fontStyle?: readonly string[]; }; }[] = [];
	const capture = async (): Promise<void> => {
		let token: LanguageToken | undefined;
		await syntax.runLatest('tokens', { languageId: 'demo' }, result => {
			if (result.value.lane !== 'tokens') throw new Error('Unexpected syntax result lane');
			token = result.value.value.tokens[0];
		});
		if (!token) {
			throw new Error('TextMate Worker did not tokenize the registered grammar');
		}
		results.push({ type: token.tokenType, modifiers: token.modifiers, ...(token.presentation ? { presentation: token.presentation } : {}) });
	};
	await capture();
	scopeTheme.replace({ revision: 1, rules: [{ selector: 'keyword.control.demo', tokenType: 'keyword', modifiers: ['declaration'] }] });
	await capture();
	scopeTheme.replace({ revision: 2, rules: [{ selector: 'keyword.control.demo', tokenType: 'keyword', modifiers: ['declaration'], foreground: '#ff0000', fontStyle: ['italic'] }] });
	await capture();
	scopeTheme.replace({ revision: 3, rules: [{ selector: 'keyword.control.demo', tokenType: 'keyword', modifiers: ['declaration'], foreground: '#0000ff', fontStyle: ['bold'] }] });
	await capture();
	catalogs.replace({
		revision: 2,
		grammars: [{ ...catalogs.currentCatalog.grammars[0]!, content: JSON.stringify({ scopeName: 'source.demo', patterns: [{ match: '\\bif\\b', name: 'string.quoted.demo' }] }) }],
	});
	await capture();
	syntax.restartWorker();
	await capture();
	return results;
};

const resources = new DisposableStore();
const extensionThemes = resources.add(new ExtensionColorThemeService(createBrowserExtensionApi(), {
	subscribe: () => ({ dispose() { } }),
}));
await extensionThemes.start();
const configuration = resources.add(new WorkbenchConfigurationService());
await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
const services = resources.add(new InstantiationService());
services.registerInstance(IConfigurationService, configuration);
const languages = resources.add(new LanguageService());
resources.add(languages.registerLanguage({ id: 'typescript', extensions: ['.ts'] }));
services.registerInstance(ILanguageService, languages);
services.registerInstance(IHostColorSchemeService, resources.add(new BrowserHostColorSchemeService(window)));
const themes = resources.add(services.createInstance(WorkbenchThemeService, document.querySelector<HTMLElement>('#root')!));
themes.initialize();
appendIcon(Lxicon.add, document.querySelector<HTMLElement>('#product-icon')!);
appendIcon(registerIcon('browser-test-semantic-product', Lxicon.chevronRight, 'Browser test semantic product icon'), document.querySelector<HTMLElement>('#semantic-product-icon')!);
const iconSelectBox = resources.add(new IconSelectBox({ icons: [Lxicon.add, Lxicon.chevronRight, Lxicon.check], showIconInfo: true }));
const iconSelectHost = document.querySelector<HTMLElement>('#icon-select-host')!;
iconSelectHost.append(iconSelectBox.domNode);
iconSelectBox.layout({ width: 240, height: 180 });
resources.add(iconSelectBox.onDidSelect(icon => { iconSelectHost.dataset.selectedIcon = icon.id; }));
window.disposeIconSelectBox = () => iconSelectBox.dispose();
window.registerLateThemeColor = () => {
	registerColor('test.browserLate', { dark: '#123456', light: '#abcdef', highContrastDark: '#ffffff', highContrastLight: '#000000' }, { description: 'Late browser test.', owner: 'test' });
};
window.disposeThemeRoot = () => themes.dispose();
window.selectColorTheme = id => configuration.updateValue(WorkbenchConfiguration.colorTheme, id);
window.setThemeSetting = (key, value) => configuration.updateValue(key, value);
let nestedHighContrastWidget: { host: HTMLElement; service: TestThemeService; binding: { dispose(): void; }; } | undefined;
window.mountNestedHighContrastWidget = () => {
	const host = document.createElement('div');
	host.id = 'nested-high-contrast-root';
	const widget = document.createElement('div');
	widget.className = 'ash-context-view-default';
	host.append(widget);
	document.querySelector<HTMLElement>('#root')!.append(host);
	const service = new TestThemeService(highContrastDarkColorTheme);
	const binding = bindColorTheme(service, host);
	nestedHighContrastWidget = { host, service, binding };
};
window.disposeNestedHighContrastWidget = () => {
	nestedHighContrastWidget?.binding.dispose();
	nestedHighContrastWidget?.service.dispose();
	nestedHighContrastWidget?.host.remove();
	nestedHighContrastWidget = undefined;
};
const render = (): void => themes.renderFileIcon(URI.file('/workspace/main.ts'), document.querySelector<HTMLElement>('#icon')!);
resources.add(themes.onDidChangeResourceIcons(render));
const manifestJson = JSON.stringify({ ...manifest, contributes: { ...manifest.contributes, productIconThemes: [{ id: 'test-svg-product', label: 'Test SVG product icons', path: './product-icons/theme.json' }, { id: 'test-font-product', label: 'Font icons', path: './icons/font-product.json' }] } });
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestJson));
const hash = 'sha256:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
const urls: Record<string, string> = { 'icons/vs-seti-icon-theme.json': themeUrl, 'icons/seti.woff': fontUrl, 'product-icons/theme.json': productThemeUrl, 'product-icons/add.svg': productIconUrl };
const grammars = resources.add(new TextMateGrammarService());
const extensions = resources.add(new AppServerExtensionService({
	api: {
		list: async () => ({
			generation: 1, diagnostics: [], extensions: [{
				id: 'ash.theme-seti', name: manifest.name, publisher: manifest.publisher, version: manifest.version,
				displayName: manifest.displayName, sourceKind: 'builtIn', manifestJson, manifestSha256: hash, packageSha256: hash,
			}]
		}),
		readResource: async request => {
			if (request.path === 'icons/font-product.json') {
				return new TextEncoder().encode(JSON.stringify({ fonts: [{ id: 'seti', weight: '700', style: 'italic', src: [{ path: 'seti.woff', format: 'woff' }] }], iconDefinitions: { add: { fontCharacter: '\\E001', fontId: 'seti' } } }));
			}
			if (!urls[request.path]) { throw new Error('Unexpected icon resource'); }
			const response = await fetch(urls[request.path]!);
			if (!response.ok) { throw new Error('Icon resource failed'); }
			return new Uint8Array(await response.arrayBuffer());
		},
	},
	textMateService: { grammars } as unknown as ITextMateService,
}));
await extensions.start();
window.disposeThemeExtensions = () => extensions.dispose();
render();
document.querySelector('#none')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.iconTheme, null); });
document.querySelector('#seti')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.iconTheme, 'vs-seti'); });
document.querySelector('#light')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light'); });
document.querySelector('#svg-icons')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.productIconTheme, 'test-svg-product'); });
document.querySelector('#default-icons')!.addEventListener('click', () => { void configuration.updateValue(WorkbenchConfiguration.productIconTheme, 'default'); });
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const workspace = resources.add(new WorkspaceContextService({ id: 'icon-models', folders: [] }));
resources.add(languages.registerLanguage({ id: 'rust' }));
const models = resources.add(new BrowserTextModelService({ onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '', revision: undefined }), save: async () => ({ revision: undefined }) }, { languageService: languages }));
const labels = resources.add(new ResourceLabels(DEFAULT_LABELS_CONTAINER, { workspaceContextService: workspace, resourceIconRenderer: themes, fileModels: models, languageService: languages }));
const decorations = resources.add(new DecorationsService(document, new NullLoggerService()));
const decorationUpdates = resources.add(new Emitter<readonly URI[]>());
let decorationData: IDecorationData | undefined;
const decorationProvider = resources.add(decorations.registerDecorationsProvider({ label: 'Browser test', onDidChange: decorationUpdates.event, provideDecorations: async () => decorationData }));
const decoratedLabels = resources.add(new ResourceLabels(DEFAULT_LABELS_CONTAINER, { workspaceContextService: workspace, resourceIconRenderer: themes, decorationsService: decorations }));
const decoratedHost = document.createElement('button');
decoratedHost.id = 'decorated-label';
document.querySelector('#root')!.append(decoratedHost);
const decoratedUri = URI.file('/workspace/ignored.log');
decoratedLabels.create(decoratedHost).setFile(decoratedUri, { hidePath: true, fileDecorations: { colors: true, badges: true } });
window.setLabelDecoration = data => { decorationData = data; decorationUpdates.fire([decoratedUri]); };
window.removeLabelDecorationProvider = () => decorationProvider.dispose();
const modelReferences: TextModelReference[] = [];
for (const [id, resource] of [['model-icon', URI.file('/workspace/no-extension')], ['untitled-icon', URI.parse('untitled:/Untitled-1')]] as const) {
	modelReferences.push(resources.add(await models.acquire({ resource, languageId: 'typescript' }, new AbortController().signal)));
	const host = document.createElement('button');
	host.id = id;
	document.querySelector('#root')!.append(host);
	labels.create(host).setResource({ resource, name: id });
}
window.changeIconModelLanguage = id => { for (const reference of modelReferences) reference.model.setLanguage(languages.createById(id)); };
window.releaseIconModels = () => { for (const reference of modelReferences) reference.dispose(); };
const pathHost = document.createElement('button');
pathHost.id = 'path-label';
pathHost.style.display = 'flex';
pathHost.style.width = '240px';
document.querySelector('#root')!.append(pathHost);
const pathLabel = labels.create(pathHost);
pathLabel.element.style.width = '100%';
pathLabel.setResource({
	resource: URI.file('/workspace/app-ts/src/ash/workbench/contrib/git/browser/gitHistoryProvider.ts'),
	name: 'gitHistoryProvider.ts',
	description: 'app-ts/src/ash/workbench/contrib/git/browser',
}, { reserveIconSpace: true });
window.disposeIconLabels = () => labels.dispose();
document.body.dataset.ready = 'true';


window.previewInTextMateWorker = async () => {
	using catalogs = new TextMateGrammarCatalogModel({
		revision: 1, grammars: [{
			scopeName: 'source.preview', languageId: 'preview', injectTo: [],
			content: JSON.stringify({ scopeName: 'source.preview', patterns: [{ begin: '"', end: '"', name: 'string.quoted.preview' }, { match: '\\bif\\b', name: 'keyword.control.preview' }] }),
		}]
	});
	using theme = new TextMateScopeThemeModel();
	using model = new TextModel('"start\nend"\nif', { languageId: 'preview', tokenization: { syntaxService: { workerFactory: createTextMateSyntaxWorkerFactory(catalogs, theme) } } });
	const signal = new AbortController().signal;
	const preview = await model.tokenization.tokenizeLinesAtAsync(2, ['[)"', 'if'], signal);
	const first = await model.tokenization.tokenizeLinesAtAsync(3, ['if'], signal);
	const second = await model.tokenization.tokenizeLinesAtAsync(3, ['if'], signal);
	return { preview: preview!.map(line => `${line.getLineContent()}:${line.getStandardTokenType(0)}`), unchanged: first![0]!.equals(second![0]!), text: model.getText() };
};
