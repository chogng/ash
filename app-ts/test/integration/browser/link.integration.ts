import '../../../src/ash/editor/editor.all.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IOutputService } from '../../../src/ash/workbench/services/output/common/output.js';
import { ITextModelService } from '../../../src/ash/editor/common/services/resolverService.js';
import { ITextModelResourceService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../src/ash/workbench/services/textmodelResolver/common/textModelResolverService.js';
import { BrowserTextModelService } from '../../../src/ash/workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { TextResourceEditor } from '../../../src/ash/workbench/browser/parts/editor/textResourceEditor.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import type { ITextResourceStore } from '../../../src/ash/workbench/services/textmodelResolver/common/textResourceStore.js';
import { Event } from '../../../src/ash/base/common/event.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { ICodeEditorService } from '../../../src/ash/editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../src/ash/editor/browser/services/openerService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { HoverConfiguration } from '../../../src/ash/platform/hover/common/hoverService.js';
import { StandaloneServiceCollection } from '../../../src/ash/editor/standalone/browser/standaloneServices.js';
import { Link } from '../../../src/ash/platform/opener/browser/link.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { OutputViewPane } from '../../../src/ash/workbench/contrib/output/browser/outputView.js';
import { OutputService } from '../../../src/ash/workbench/contrib/output/browser/outputServices.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { WorkbenchQuickInputService } from '../../../src/ash/workbench/services/quickinput/browser/quickInputService.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { ExternalUriOpenerService } from '../../../src/ash/workbench/contrib/externalUriOpener/common/externalUriOpenerService.js';
import { ExternalUriOpenerPriority } from '../../../src/ash/editor/common/languages.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import '../../../src/ash/workbench/contrib/externalUriOpener/common/externalUriOpener.contribution.js';

declare global {
	interface Window {
		ashLinkIntegration: {
			readonly opened: readonly string[];
			readonly customOpened: readonly string[];
			readonly files: readonly { resource: string; line: number; column: number }[];
			readonly contributed: readonly string[];
			readonly settingsRevealed: readonly string[];
			installExternalOpeners(chinese?: boolean): void;
			setEnabled(enabled: boolean): void;
			update(label: string, title?: string, tabIndex?: number, elementLabel?: boolean): void;
			setTheme(index: number): void;
			blockOpening(): void;
			disposeLink(): void;
			appendOutput(): void;
			appendOutputLines(count: number): void;
			getOutputScroll(): { top: number; end: number };
			clearOutput(): void;
			disposeOutput(): void;
			openOutputEditor(): Promise<void>;
			filterOutput(value: string): void;
			runOpenLink(): Promise<void>;
			getOutputState(): { panelText: string; editorText: string; sameModel: boolean; readonly: boolean };
		}
	}
}

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const editorServices = resources.add(new StandaloneServiceCollection({}));
const services = resources.add(editorServices.createChild());
const configuration = services.get(IConfigurationService);
await configuration.updateValue(HoverConfiguration.delay, 0);
const contextViews = resources.add(new BrowserContextViewService(document.body));
// Menu presentation and editor display are boundaries outside this component scenario.
const menus: IContextMenuService = {
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() {},
};
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, contextViews, menus)));
const opener = resources.add(services.createInstance(OpenerService));
services.registerInstance(IOpenerService, opener);
const opened: string[] = [];
opener.setDefaultExternalOpener({ openExternal: async href => { opened.push(href); return true; } });
const themes = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme];
const themeService = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(themeService, document.body));
const link = resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#default-link')!, {
	label: 'Documentation', href: 'https://example.test/docs', title: 'Read documentation',
}, {}));
const customOpened: string[] = [];
resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#custom-link')!, {
	label: 'Custom action', href: 'https://example.test/custom',
}, { opener: (href: string) => customOpened.push(href), textLinkForeground: '#ff8080' }));
const workspace = resources.add(new WorkspaceContextService({ id: 'link-test', uri: URI.file('/workspace') }));
services.registerInstance(IWorkspaceContextService, workspace);
services.registerInstance(IContextMenuService, menus);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, applicationId: 'link', workspaceId: 'link', backend: window.localStorage, flushInterval: 0 })));
services.registerInstance(IAccessibleViewService, { ...toDisposable(() => {}), show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => {}, showAccessibleViewHelp: () => {} });
const store: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: '', revision: undefined }),
	save: async () => { throw new Error('A provider-backed Output editor must not save'); },
};
services.registerInstance(ITextModelResourceService, resources.add(new BrowserTextModelService(store)));
services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
const output = resources.add(services.createInstance(OutputService));
services.registerInstance(IOutputService, output);
const channel = resources.add(output.createChannel({ id: 'link-test', label: 'Link test' }));
const files: { resource: string; line: number; column: number }[] = [];
const contributed: string[] = [];
const settingsRevealed: string[] = [];
const pane = resources.add(services.createInstance(OutputViewPane, document.querySelector<HTMLElement>('#output')!, { id: 'link-test', title: 'Output' }));
const outputTitle = document.createElement('div');
document.querySelector('#output')!.before(outputTitle);
outputTitle.append(pane.partTitleProjection.actions!);
resources.add(toDisposable(() => outputTitle.remove()));
pane.layout(240, 0, 900);
const paneEditor = services.get(ICodeEditorService).listCodeEditors().find(editor => document.querySelector('#output')!.contains(editor.getContainerDomNode()))!;
resources.add(services.get(ICodeEditorService).registerCodeEditorOpenHandler(async (input, source) => {
	const selection = input.options!.selection!;
	files.push({ resource: input.resource.toString(), line: selection.startLineNumber, column: selection.startColumn });
	return source;
}));
const liveEditorContainer = document.createElement('section');
liveEditorContainer.id = 'live-output-editor';
document.body.append(liveEditorContainer);
const liveEditor = resources.add(services.createInstance(TextResourceEditor, store, {}));
liveEditor.create(liveEditorContainer);
pane.setVisible(true);
channel.appendLine({ text: 'src/main.ts:12:7: check this file', severity: 'warning' });
window.ashLinkIntegration = {
	opened, customOpened, files, contributed, settingsRevealed,
	installExternalOpeners: chinese => {
		if (chinese) {
			const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
			setNlsMessages(catalog.locale, catalog.bundles);
		}
		services.registerInstance(IQuickInputService, resources.add(new WorkbenchQuickInputService({ container: document.body, contextKeyService: services.get(IContextKeyService) })));
		services.registerInstance(IPreferencesService, {
			openSettings: async () => {}, openGlobalKeybindingSettings: async () => {},
			openUserSettings: async options => { settingsRevealed.push(options!.revealSetting!.key); },
		});
		const external = resources.add(services.createInstance(ExternalUriOpenerService));
		resources.add(external.registerExternalOpenerProvider({
			async *getOpeners() {
				for (const id of ['First viewer', 'Second viewer']) {
					yield {
						id, label: id, canOpen: async () => ExternalUriOpenerPriority.Default,
						openExternalUri: async (uri: URI) => { contributed.push(`${id}:${uri.toString()}`); return true; },
					};
				}
			},
		}));
	},
	setEnabled: enabled => { link.enabled = enabled; },
	update: (label, title, tabIndex, elementLabel) => {
		const content = document.createElement('span');
		content.textContent = label;
		link.link = { label: elementLabel ? content : label, href: 'https://example.test/updated', title, tabIndex };
	},
	setTheme: index => themeService.setColorTheme(themes[index]!),
	blockOpening: () => { resources.add(opener.registerValidator({ shouldOpen: async () => false })); },
	disposeLink: () => link.dispose(),
	appendOutput: () => channel.appendLine({ text: 'src/other.ts(4,2): next file', severity: 'warning' }),
	appendOutputLines: count => {
		for (let line = 1; line <= count; line++) {
			channel.appendLine({ text: `live line ${line}` });
		}
	},
	getOutputScroll: () => ({ top: paneEditor.getScrollTop(), end: Math.max(0, paneEditor.getContentHeight() - paneEditor.getLayoutInfo().height) }),
	clearOutput: () => channel.clear(),
	filterOutput: value => output.filters.setText(value),
	runOpenLink: async () => { await services.get(ICommandService).executeCommand('editor.action.openLink'); },
	openOutputEditor: async () => {
		liveEditor.layout({ width: 900, height: 200 });
		await liveEditor.setInput({ resource: channel.uri, label: channel.label, readOnly: true }, new AbortController().signal);
	},
	getOutputState: () => ({ panelText: channel.getText(), editorText: liveEditor.getValue(), sameModel: liveEditor.getControl()?.getModel() === editorServices.modelService.getModel(channel.uri), readonly: liveEditor.workingCopy === undefined }),
	disposeOutput: () => pane.dispose(),
};
