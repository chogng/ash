import { DEFAULT_LOG_LEVEL } from '../../../../../../platform/log/common/log.js';
import { IDefaultLogLevelsService } from '../../../../../services/log/common/defaultLogLevels.js';
import { registerTestCodeEditorFeatures } from '../../../../../../../../test/fixtures/codeEditorFeatures.js';
const codeFeatures = registerTestCodeEditorFeatures();
import { TestUriIdentityServices } from '../../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { StandaloneServiceCollection } from '../../../../../../editor/standalone/browser/standaloneServices.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { renderMarkdown } from '../../../../../../base/browser/markdownRenderer.js';
import { ILogService, NullLoggerService } from '../../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import { openChatMarkdownLink } from '../../../../chat/browser/widget/chatWidget.js';
import { openChatMarkdownLink as openCoworkMarkdownLink } from '../../../../../../sessions/contrib/cowork/browser/widget/coworkWidget.js';
import '../../../../commands/common/commands.contribution.js';
import '../../../../../../editor/editor.all.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { IOutputService } from '../../../../../services/output/common/output.js';
import { ITextModelService } from '../../../../../../editor/common/services/resolverService.js';
import { ITextModelResourceService } from '../../../../../services/textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../../../services/textmodelResolver/common/textModelResolverService.js';
import { BrowserTextModelService } from '../../../../../services/textmodelResolver/browser/browserTextModelService.js';
import { TextResourceEditor } from '../../../../../browser/parts/editor/textResourceEditor.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import type { ITextResourceStore } from '../../../../../services/textmodelResolver/common/textResourceStore.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../../editor/browser/services/openerService.js';
import { BrowserContextViewService } from '../../../../../../platform/contextview/browser/contextViewService.js';
import { HoverService, IHoverService } from '../../../../../../platform/hover/browser/hoverService.js';
import { HoverConfiguration } from '../../../../../../platform/hover/common/hoverService.js';
import { Link } from '../../../../../../platform/opener/browser/link.js';
import { IOpenerService } from '../../../../../../platform/opener/common/opener.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { OutputViewPane } from '../../../../output/browser/outputView.js';
import { OutputService } from '../../../../output/browser/outputServices.js';
import { TestWorkspaceService } from '../../../../../services/configuration/test/common/testServices.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IPreferencesService } from '../../../../../services/preferences/common/preferences.js';
import { ExternalUriOpenerService } from '../../../../externalUriOpener/common/externalUriOpenerService.js';
import { ExternalUriOpenerPriority } from '../../../../../../editor/common/languages.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import { setNlsMessages } from '../../../../../../nls.js';
import '../../../../externalUriOpener/common/externalUriOpener.contribution.js';

declare global {
	interface Window {
		ashLinkIntegration: {
			readonly commandCalls: readonly unknown[];
			commandLink(trusted: boolean, failure?: boolean, cowork?: boolean): void;
			readonly opened: readonly string[];
			readonly customOpened: readonly string[];
			readonly files: readonly { resource: string; line: number; column: number; }[];
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
			getOutputScroll(): { top: number; end: number; };
			clearOutput(): void;
			disposeOutput(): void;
			openOutputEditor(): Promise<void>;
			filterOutput(value: string): void;
			runOpenLink(): Promise<void>;
			getOutputState(): { panelText: string; editorText: string; sameModel: boolean; readonly: boolean; };
		};
	}
}

const resources = new DisposableStore();
const uriIdentityServices = resources.add(new TestUriIdentityServices());
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const editorServices = resources.add(new StandaloneServiceCollection({}));
registerTestComponentServices(editorServices);
const services = resources.add(editorServices.createChild());
services.registerInstance(ICommandService, resources.add(new CommandService(services)));
const configuration = services.get(IConfigurationService);
await configuration.updateValue(HoverConfiguration.delay, 0);
const contextViews = resources.add(new BrowserContextViewService(document.body));
// Menu presentation and editor display are boundaries outside this component scenario.
const menus: IContextMenuService = {
	contextMenuStyle: 'custom',
	onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: () => { throw new Error('Unexpected context menu'); }, hideContextMenu() { },
};
services.registerInstance(IHoverService, resources.add(new HoverService(configuration, contextViews, menus)));
const opener = resources.add(services.createInstance(OpenerService));
services.registerInstance(IOpenerService, opener);
const opened: string[] = [];
opener.setDefaultExternalOpener({ openExternal: async href => { opened.push(href); return true; } });
const themes = [darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme];
const themeService = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindTestColorTheme(themeService, document.body));
const link = resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#default-link')!, {
	label: 'Documentation', href: 'https://example.test/docs', title: 'Read documentation',
}, {}));
const customOpened: string[] = [];
resources.add(services.createInstance(Link, document.querySelector<HTMLElement>('#custom-link')!, {
	label: 'Custom action', href: 'https://example.test/custom',
}, { opener: (href: string) => customOpened.push(href), textLinkForeground: '#ff8080' }));
const workspace = resources.add(new TestWorkspaceService({ id: 'link-test', uri: URI.file('/workspace') }));
services.registerInstance(IWorkspaceContextService, workspace);
services.registerInstance(IContextMenuService, menus);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'link', backend: window.localStorage, flushInterval: 0 })));
services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { } });
const store: ITextResourceStore = {
	onDidChange: Event.None,
	resolve: async request => ({ resource: request.resource, text: '', revision: undefined }),
	save: async () => { throw new Error('A provider-backed Output editor must not save'); },
};
registerTestComponentServices(services);
services.registerInstance(ITextModelResourceService, resources.add(services.createInstance(BrowserTextModelService, store, {})));
services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
const output = resources.add(services.createInstance(OutputService));
services.registerInstance(IOutputService, output);
const channel = resources.add(output.createChannel({ id: 'link-test', label: 'Link test' }));
const files: { resource: string; line: number; column: number; }[] = [];
const contributed: string[] = [];
const settingsRevealed: string[] = [];
services.registerInstance(IDefaultLogLevelsService, {
	defaultLogLevels: { default: DEFAULT_LOG_LEVEL, extensions: [] }, onDidChangeDefaultLogLevels: Event.None,
	getDefaultLogLevel: () => DEFAULT_LOG_LEVEL,
	setDefaultLogLevel: async () => { throw new Error('Log configuration is outside this link fixture'); },
});
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
const commandCalls: unknown[] = [];
const commandHost = document.createElement('section');
commandHost.id = 'command-link';
document.body.append(commandHost);
services.registerInstance(ILogService, new NullLoggerService());
const commandNotifications = resources.add(new TestNotificationService());
services.registerInstance(INotificationService, commandNotifications);
resources.add(commandNotifications.model.onDidAdd(item => {
	const notice = document.createElement('div');
	notice.setAttribute('role', 'alert');
	notice.textContent = item.message;
	commandHost.append(notice);
}));
resources.add(CommandsRegistry.registerMany([
	{ id: 'test.link.first', handler: async (_accessor, value) => { commandCalls.push(value); await Promise.resolve(); commandCalls.push('first finished'); } },
	{ id: 'test.link.second', handler: () => commandCalls.push('second') },
]));
window.ashLinkIntegration = {
	opened, customOpened, files, contributed, settingsRevealed, commandCalls,
	commandLink: (trusted, failure, cowork) => {
		const router = cowork ? openCoworkMarkdownLink : openChatMarkdownLink;
		const commands: unknown[] = [{ command: 'test.link.first', args: { text: '%20 中文' } }];
		if (failure) commands.push('test.link.missing');
		commands.push('test.link.second');
		const href = `command:runCommands?${encodeURIComponent(JSON.stringify({ commands }))}`;
		const rendered = resources.add(renderMarkdown({ value: `[Run linked commands](${href})`, isTrusted: trusted }, {
			ownerDocument: document,
			actionHandler: target => { void router(target, opener, undefined).catch(error => { throw error; }); }
		}));
		commandHost.replaceChildren(rendered.element);
	},
	installExternalOpeners: chinese => {
		if (chinese) {
			const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
			setNlsMessages(catalog.locale, catalog.bundles);
		}
		services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ instantiationService: services, container: document.body, contextKeyService: services.get(IContextKeyService) })));
		services.registerInstance(IPreferencesService, {
			openSettings: async () => { }, openGlobalKeybindingSettings: async () => { },
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
