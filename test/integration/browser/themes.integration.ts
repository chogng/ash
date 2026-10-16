import { createDisconnectedSyntaxApi } from '../../../src/ash/platform/syntax/browser/syntaxApi.js';
import { parseUserColorTheme } from '../../../src/ash/workbench/services/themes/common/colorThemeData.js';
import { TreeSitterLibraryService, createTreeSitterSyntaxTokenBackend } from '../../../src/ash/workbench/services/treeSitter/browser/treeSitterLibraryService.js';
import { rustSyntaxFixture } from './rustSyntaxHostFixture.js';
import { createEmptyTestLanguagePacks } from '../../../src/ash/workbench/services/localization/test/common/localizationTestUtils.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { TestUriIdentityServices } from '../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { ExtensionResourceLoaderService } from '../../../src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { ExtensionColorThemeService } from '../../../src/ash/workbench/services/extensions/browser/extensionColorThemeService.js';
import { createBuiltinExtensionFixture } from './builtinExtensionsFixture.js';
import '../../../src/ash/workbench/browser/parts/notifications/media/notificationsList.css';
import '../../../src/ash/workbench/browser/parts/notifications/media/notificationsToasts.css';
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
import manifest from '../../../extensions/theme-seti/package.json' with { type: 'json' };
import themeUrl from '../../../extensions/theme-seti/icons/vs-seti-icon-theme.json?url';
import fontUrl from '../../../extensions/theme-seti/icons/seti.woff?url';
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
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { AppServerExtensionService } from '../../../src/ash/workbench/services/extensions/browser/appServerExtensionService.js';
import { WorkbenchThemeService } from '../../../src/ash/workbench/services/themes/browser/workbenchThemeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { TextModel } from '../../../src/ash/editor/common/model/textModel.js';
import { registerColor } from '../../../src/ash/platform/theme/common/colorUtils.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
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
		previewWithRustSyntax(): Promise<{ hasString: boolean; hasKeyword: boolean; unchanged: boolean; text: string; }>;
		tokenizeWithSyntax(): Promise<readonly { type: string; modifiers: readonly string[]; presentation?: { foreground?: string; fontStyle?: readonly string[]; }; }[]>;
		setLabelDecoration(data: IDecorationData | undefined): void;
		removeLabelDecorationProvider(): void;
	}
}

window.tokenizeWithSyntax = async () => {
	using scopeTheme = new TestThemeService(parseUserColorTheme('{}', 'empty-theme'));
	using library = new TreeSitterLibraryService(new URL(location.href).searchParams.get('backend') === 'offline'
		? createDisconnectedSyntaxApi(operation => { throw new Error(`Unexpected offline syntax request: ${operation}`); })
		: await rustSyntaxFixture());
	const configuration = { getValue: () => false } as unknown as IConfigurationService;
	const create = (text: string): TextModel => new TextModel(text, {
		languageId: 'javascript', tokenization: {
			createSyntaxTokenBackend: model => createTreeSitterSyntaxTokenBackend(model, configuration, library, scopeTheme),
			onDidChangeSyntaxBackend: listener => scopeTheme.onDidColorThemeChange(() => listener()),
		},
	});
	let model = create('if (true) {}');
	const results: { type: string; modifiers: readonly string[]; presentation?: { foreground?: string; fontStyle?: readonly string[]; }; }[] = [];
	const capture = async (): Promise<void> => {
		const tree = model.tokenization.syntaxTree!;
		await tree.whenReady(new AbortController().signal);
		const token = tree.getLanguageTokens(1)[0];
		if (!token) throw new Error('Tree-sitter did not return a token');
		const { foreground, fontStyle } = token.presentation ?? {};
		results.push({ type: token.tokenType, modifiers: token.modifiers, ...(foreground || fontStyle ? { presentation: { foreground, fontStyle } } : {}) });
	};
	try {
		await capture();
		scopeTheme.setColorTheme(parseUserColorTheme('{"semanticTokenColors":{"keyword":{"foreground":"#ff0000","fontStyle":"italic"}}}', 'red-theme'));
		await capture();
		scopeTheme.setColorTheme(parseUserColorTheme('{"semanticTokenColors":{"keyword":{"foreground":"#0000ff","fontStyle":"bold"}}}', 'blue-theme'));
		await capture();
		model.setValue('"if"');
		await capture();
		model.dispose();
		model = create('"if"');
		await capture();
		return results;
	} finally { model.dispose(); }
};

const resources = new DisposableStore();
const uriIdentityServices = resources.add(new TestUriIdentityServices());
const extensionThemes = resources.add(new ExtensionColorThemeService(createBuiltinExtensionFixture(), {
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
	registerColor('test.browserLate', { dark: '#123456', light: '#abcdef', hcDark: '#ffffff', hcLight: '#000000' }, { description: 'Late browser test.', owner: 'test' });
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
const extensions = resources.add(new AppServerExtensionService({
	api: {
		list: async () => ({
			generation: 1, diagnostics: [], extensions: [{
				id: 'ash.theme-seti', name: manifest.name, publisher: manifest.publisher, version: manifest.version,
				displayName: manifest.displayName, sourceKind: 'builtIn', manifestJson, manifestSha256: hash, packageSha256: hash,
			}]
		}),
		resources: new ExtensionResourceLoaderService(async request => {
			if (request.path === 'icons/font-product.json') {
				return new TextEncoder().encode(JSON.stringify({ fonts: [{ id: 'seti', weight: '700', style: 'italic', src: [{ path: 'seti.woff', format: 'woff' }] }], iconDefinitions: { add: { fontCharacter: '\\E001', fontId: 'seti' } } }));
			}
			if (!urls[request.path]) { throw new Error('Unexpected icon resource'); }
			const response = await fetch(urls[request.path]!);
			if (!response.ok) { throw new Error('Icon resource failed'); }
			return new Uint8Array(await response.arrayBuffer());
		}),
	},

}, createEmptyTestLanguagePacks()));
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
const models = resources.add(uriIdentityServices.createInstance(BrowserTextModelService, { onDidChange: Event.None, resolve: async request => ({ resource: request.resource, text: '', revision: undefined }), save: async () => ({ revision: undefined }) } satisfies ITextResourceStore, { languageService: languages }));
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
	resource: URI.file('/workspace/src/ash/workbench/contrib/git/browser/gitHistoryProvider.ts'),
	name: 'gitHistoryProvider.ts',
	description: 'src/ash/workbench/contrib/git/browser',
}, { reserveIconSpace: true });
window.disposeIconLabels = () => labels.dispose();
document.body.dataset.ready = 'true';


window.previewWithRustSyntax = async () => {
	using theme = new TestThemeService(parseUserColorTheme('{}', 'empty-theme'));
	using library = new TreeSitterLibraryService(await rustSyntaxFixture());
	const configuration = { getValue: () => false } as unknown as IConfigurationService;
	using model = new TextModel('const text = `start\nend`;\nif (true) {}', {
		languageId: 'javascript',
		tokenization: { createSyntaxTokenBackend: model => createTreeSitterSyntaxTokenBackend(model, configuration, library, theme) },
	});
	const before = model.getValue();
	const preview = await model.tokenization.syntaxTree!.tokenizeLinesAtAsync(2, ['changed`;', 'if (true) {}'], new AbortController().signal);
	return { hasString: preview[0]!.some(token => token.tokenType === 'string'), hasKeyword: preview[1]!.some(token => token.tokenType === 'keyword'), unchanged: model.getValue() === before, text: model.getValue() };
};
