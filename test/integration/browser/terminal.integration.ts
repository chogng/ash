import { ITerminalCompletionService, TerminalCompletionService } from '../../../src/ash/workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js';
import { ITerminalQuickFixService } from '../../../src/ash/workbench/contrib/terminalContrib/quickFix/browser/quickFix.js';
import { TerminalQuickFixService } from '../../../src/ash/workbench/contrib/terminalContrib/quickFix/browser/terminalQuickFixService.js';
import { ITerminalLinkProviderService } from '../../../src/ash/workbench/contrib/terminalContrib/links/browser/links.js';
import { TerminalLinkProviderService } from '../../../src/ash/workbench/contrib/terminalContrib/links/browser/terminalLinkProviderService.js';
import { ISearchService } from '../../../src/ash/workbench/services/search/common/search.js';
import { IHostService } from '../../../src/ash/workbench/services/host/browser/host.js';
import { TestHostService } from '../../../src/ash/workbench/services/host/test/browser/testHostService.js';
import { IWorkbenchEnvironmentService } from '../../../src/ash/workbench/services/environment/common/environmentService.js';
import { ILabelService } from '../../../src/ash/platform/label/common/label.js';
import { LabelService } from '../../../src/ash/workbench/services/label/common/labelService.js';
import { InstantiationType } from '../../../src/ash/platform/instantiation/common/extensions.js';
import { TerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalService.js';
import { TerminalEditorService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalEditorService.js';
import { IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { DialogService } from '../../../src/ash/workbench/services/dialogs/common/dialogService.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.js';
import { DialogHandlerContribution } from '../../../src/ash/workbench/browser/parts/dialogs/dialog.web.contribution.js';
import { ISecretStorageService, BaseSecretStorageService } from '../../../src/ash/platform/secrets/common/secrets.js';
import { IUriIdentityService } from '../../../src/ash/platform/uriIdentity/common/uriIdentity.js';
import { IEditorGroupsService } from '../../../src/ash/workbench/services/editor/common/editorGroupsService.js';
import { ITerminalEditorService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { getTerminalUri } from '../../../src/ash/workbench/contrib/terminal/browser/terminalUri.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import { ILocalizationService } from '../../../src/ash/workbench/services/localization/common/localizationService.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { ITaskService } from '../../../src/ash/workbench/contrib/tasks/common/taskService.js';
import '../../../src/ash/workbench/contrib/chat/browser/chat.shared.contribution.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import '../../../src/ash/workbench/contrib/terminal/browser/terminal.web.contribution.js';
import { writeP } from '../../../src/ash/workbench/contrib/terminal/browser/terminalTestHelpers.js';
import { IHoverService, HoverService } from '../../../src/ash/platform/hover/browser/hoverService.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { IEnvironmentVariableService } from '../../../src/ash/workbench/contrib/terminal/common/environmentVariable.js';
import { EnvironmentVariableService } from '../../../src/ash/workbench/contrib/terminal/common/environmentVariableService.js';
import '../../../src/ash/base/browser/ui/splitview/splitview.css';
import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { TerminalGroupService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalGroupService.js';
import { ITerminalGroupService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../src/ash/platform/storage/common/storage.js';
import { TerminalStorageKeys } from '../../../src/ash/workbench/contrib/terminal/common/terminalStorageKeys.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/common/configurationResolver.js';
import { ConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/browser/configurationResolverService.js';
import { IPathService } from '../../../src/ash/platform/path/common/pathService.js';
import { BrowserPathService } from '../../../src/ash/workbench/services/path/browser/pathService.js';
import { IRendererHostService } from '../../../src/ash/platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../src/ash/workbench/browser/rendererApi.js';
import { TestWorkspaceService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { ITerminalContributionService, ITerminalProfileResolverService, ITerminalProfileService } from '../../../src/ash/workbench/contrib/terminal/common/terminal.js';
import { BrowserTerminalProfileResolverService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileResolverService.js';
import { MainThreadTerminalService } from '../../../src/ash/workbench/api/browser/mainThreadTerminalService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../src/ash/platform/workspace/common/workspace.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { TerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { TerminalProfileService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileService.js';
import { ITerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';

import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ITerminalProcessService, TerminalLocation } from '../../../src/ash/platform/terminal/common/terminal.js';
import { OperatingSystem } from '../../../src/ash/base/common/platform.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { createColorTheme, darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IMenuService, MenuId } from '../../../src/ash/platform/actions/common/actions.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { AppServerAvailableContext } from '../../../src/ash/workbench/common/contextkeys.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { CommandRegistry, CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { KeybindingRegistry } from '../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import '../../../src/ash/workbench/contrib/commands/common/commands.contribution.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import '../../../src/ash/workbench/contrib/terminalContrib/voice/browser/terminal.voice.contribution.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IExplorerService } from '../../../src/ash/workbench/contrib/files/browser/files.js';
import { ExplorerService } from '../../../src/ash/workbench/contrib/files/browser/explorerService.js';
import { TERMINAL_VIEW_ID } from '../../../src/ash/workbench/contrib/terminal/common/terminal.js';
import { ContextKeyService, IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ITerminalService, type ITerminalDimensions, type ITerminalInstance } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { GeneralShellType, ITerminalLogService, PosixShellType } from '../../../src/ash/platform/terminal/common/terminal.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/renderer/common/dictation.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { TestNotificationService } from './notificationFixture.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { extUri } from '../../../src/ash/base/common/resources.js';
import { BrowserLayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { Dimension, type IDimension } from '../../../src/ash/base/browser/dom.js';
import { WorkbenchLayout } from '../../../src/ash/workbench/browser/layout.js';
import { Part } from '../../../src/ash/workbench/browser/part.js';
import { IWorkbenchLayoutService, Position, workbenchPartIds, type WorkbenchPartId } from '../../../src/ash/workbench/services/layout/browser/layoutService.js';
import { BrowserAuxiliaryWindowService, IAuxiliaryWindowService } from '../../../src/ash/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { createCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { XtermTerminal } from '../../../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.js';
import { TerminalCapability } from '../../../src/ash/platform/terminal/common/capabilities/capabilities.js';

import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { TerminalActiveInstanceStateContext, TerminalHasActiveInstanceContext } from '../../../src/ash/workbench/contrib/terminal/common/terminalContextKey.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const store = new DisposableStore();
if (new URLSearchParams(location.search).has('workbench')) {
	await import('../../../src/ash/workbench/browser/media/style.css');
	document.body.classList.add('ash-workbench');
}
store.add(installTestDictationAudio(window));
setIconResolver(document, icon => getIconDefinition(icon));
function createTerminalFixtureLayout(root: HTMLElement, lifetime: DisposableStore): IWorkbenchLayoutService {
	return Object.assign(lifetime.add(new BrowserLayoutService({ root })), {
		getPanelPosition: () => Position.BOTTOM, setPanelPosition: () => { }, onDidChangePanelPosition: Event.None,
		getSideBarPosition: () => Position.LEFT,
		onDidChangeAuxiliaryBarMaximized: Event.None, isAuxiliaryBarMaximized: () => false,
		toggleMaximizedAuxiliaryBar: () => { }, setAuxiliaryBarMaximized: () => false,
		onDidChangePartVisibility: Event.None, isPartVisible: () => true, hidePart: () => { }, hasFocus: () => false,
		setLayoutStyle: () => { }, getVisibleNeighborPart: () => undefined, isPanelMaximized: () => false,
		toggleMaximizedPanel: () => { }, getPartSize: () => ({ width: root.clientWidth, height: root.clientHeight }),
		resizePart: () => { }, showPart: () => { }, showParts: () => { }, hideParts: () => { },
	});
}

function setupTerminalFixtureServices(services: import('../../../src/ash/platform/instantiation/common/instantiationService.js').InstantiationService, lifetime: DisposableStore, fallbackProcess = true, provideLayout = true): void {
	if (!services.has(IHostService)) services.registerInstance(IHostService, new TestHostService());
	// Filename discovery is an explicit boundary of the terminal-only fixture.
	if (!services.has(ISearchService)) services.registerInstance(ISearchService, {
		fileSearch: async () => ({ results: [], messages: [] }),
		textSearch: async () => { throw new Error('Terminal fixture does not search file contents'); },
	});
	if (!services.has(IWorkbenchEnvironmentService)) services.registerInstance(IWorkbenchEnvironmentService, {
		argvResource: URI.from({ scheme: 'vscode-userdata', path: '/user/argv.json' }),
		webviewExternalEndpoint: 'http://{{uuid}}.localhost',
		expectsTerminalTransfer: new URLSearchParams(location.search).has('transfer'),
	});
	// Keep the concrete owner observable after scope disposal for cleanup assertions.
	if (provideLayout && !services.has(IWorkbenchLayoutService)) services.registerInstance(IWorkbenchLayoutService, createTerminalFixtureLayout(document.querySelector<HTMLElement>('#terminal')!, lifetime));
	if (!services.has(ITerminalService)) services.registerSingleton(ITerminalService, () => services.createInstance(TerminalService), { instantiation: InstantiationType.Delayed });
	if (!services.has(IDialogService)) services.registerSingleton(IDialogService, () => services.createInstance(DialogService));
	if (!services.has(ISecretStorageService)) services.registerInstance(ISecretStorageService, lifetime.add(new BaseSecretStorageService()));
	if (!services.has(ITerminalGroupService)) services.registerSingleton(ITerminalGroupService, () => services.createInstance(TerminalGroupService), { instantiation: InstantiationType.Delayed });
	if (!services.has(ITerminalEditorService)) services.registerSingleton(ITerminalEditorService, () => services.createInstance(TerminalEditorService), { instantiation: InstantiationType.Delayed });
	if (!services.has(IStorageService)) services.registerInstance(IStorageService, lifetime.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'terminal-integration', flushInterval: 0 })));
	if (!services.has(ITerminalCompletionService)) services.registerInstance(ITerminalCompletionService, lifetime.add(services.createInstance(TerminalCompletionService)));
	if (!services.has(ITerminalQuickFixService)) services.registerInstance(ITerminalQuickFixService, lifetime.add(services.createInstance(TerminalQuickFixService)));
	if (!services.has(ITerminalLinkProviderService)) services.registerSingleton(ITerminalLinkProviderService, () => services.createInstance(TerminalLinkProviderService));
	if (!services.has(IEnvironmentVariableService)) services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
	if (!services.has(IHoverService)) services.registerInstance(IHoverService, lifetime.add(new HoverService(services.get(IConfigurationService), lifetime.add(new BrowserContextViewService(document.body)), { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } })));
	services.registerInstance(ITerminalContributionService, { terminalProfiles: [], onDidChangeTerminalProfiles: Event.None, ...Disposable.None });
	services.registerInstance(IExtensionService, { getExtensionPointContributions: () => [], currentCatalog: { generation: 0, extensions: [], diagnostics: [] }, onDidChange: Event.None, activateByEvent: async () => { } } as unknown as IExtensionService);
	const api = createDisconnectedRendererApi();
	services.registerInstance(IRendererHostService, { ...api, hasAppServer: true, appServer: { ...api.appServer, operatingSystem: OperatingSystem.Linux, userHome: '/home/test' } });
	if (!services.has(IWorkspaceContextService)) services.registerInstance(IWorkspaceContextService, lifetime.add(new TestWorkspaceService({ id: 'terminal-paths', folders: [] })));
	if (!services.has(IViewsService)) services.registerInstance(IViewsService, {
		getViewProgressIndicator: () => undefined,
		onDidChangeViewContainerVisibility: Event.None, onDidChangeViewVisibility: Event.None, onDidChangeFocusedView: Event.None,
		isViewContainerVisible: () => false, isViewContainerActive: () => false,
		openViewContainer: async () => null, closeViewContainer: () => { },
		getVisibleViewContainer: () => null, getActiveViewPaneContainerWithId: () => null,
		getFocusedView: () => null, getFocusedViewName: () => '',
		isViewVisible: () => false, openView: async () => null, closeView: () => { },
		getActiveViewWithId: () => null, getViewWithId: () => null, focusView: async () => false,
	});
	if (!services.has(IExplorerService)) services.registerSingleton(IExplorerService, () => services.createInstance(ExplorerService), { instantiation: InstantiationType.Delayed });
	services.registerSingleton(IPathService, () => services.createInstance(BrowserPathService));
	services.registerSingleton(ILabelService, () => services.createInstance(LabelService));
	if (fallbackProcess && !services.has(ITerminalProcessService)) services.registerInstance(ITerminalProcessService, { getEnvironment: async () => ({ HOME: '/home/test' }) } as unknown as ITerminalProcessService);
	services.registerInstance(IConfigurationResolverService, lifetime.add(services.createInstance(ConfigurationResolverService)));
}

const writes: string[] = [];
const binaryWrites: number[][] = [];
const resizes: ITerminalDimensions[] = [];
let nextFixtureInstance = 0;
function createFixtureInstance(id: string) {
	let screen: XtermTerminal | undefined;
	let ready: Promise<XtermTerminal | undefined> | undefined;
	let target = TerminalLocation.Panel;
	const targetChanged = store.add(new Emitter<TerminalLocation | undefined>());
	const fixture = {
		async refreshProperty() { throw new Error('Screen-only fixture has no process properties'); },
		async serializeState() { throw new Error('Screen-only fixture has no process checkpoint'); },
		...Disposable.None,
		id,
		instanceId: ++nextFixtureInstance,
		resource: getTerminalUri('integration', nextFixtureInstance),
		get target() { return target; },
		set target(value: TerminalLocation) { target = value; targetChanged.fire(value); },
		onDidChangeTarget: targetChanged.event,
		dirId: 'workspace',
		processId: 1234,
		initialCwd: '/backend/workspace',
		title: 'Shell',
		profile: { profileId: 'shell', title: 'Shell', isDefault: true },
		state: new URLSearchParams(location.search).has('exited') ? 'exited' : 'running',
		exitCode: undefined,
		onDidWriteData: Event.None,
		onDidExit: Event.None,
		onDidChangeCommandStatus: Event.None,
		onDidChangeState: Event.None,
		start: () => { },
		clearBuffer: () => screen?.clearBuffer(),
		reuseTerminal: async () => { throw new Error('Screen-only fixture has no process to reuse'); },
		setAutoReplies: async () => { }, sendSignal: async () => { }, sendText: async (data, shouldExecute) => { writes.push(data + (shouldExecute ? '\r' : '')); },
		sendPath: async () => { throw new Error('Screen-only fixture has no path input'); },
		processBinary: async data => { binaryWrites.push(Array.from(data, character => character.charCodeAt(0))); },
		resize: dimensions => { resizes.push(dimensions); },
		close: async () => { },
		getContribution: () => null,
		get xterm() { return screen; },
		get xtermReadyPromise() {
			if (!screen) return Promise.resolve(undefined);
			const createdScreen = screen;
			return ready ??= createdScreen.initialize().then(() => {
				if (createdScreen.isDisposed) return undefined;
				// Controlled input boundary for screen-only cases; assembly/input use the real instance.
				const input = createdScreen.raw.onData(data => { writes.push(data); });
				const binary = createdScreen.raw.onBinary(data => { binaryWrites.push(Array.from(data, character => character.charCodeAt(0))); });
				store.add(toDisposable(() => input.dispose()));
				store.add(toDisposable(() => binary.dispose()));
				return createdScreen;
			});
		},
		attachToElement: container => {
			if (screen && !screen.isDisposed) { container.append(screen.element); return; }
			const createdScreen = store.add(widgetServices.createInstance(XtermTerminal, container, fixture));
			screen = createdScreen;
			ready = undefined;
		},
		detachFromElement: () => { screen?.setVisible(false); screen?.element.remove(); },
	} satisfies ITerminalInstance;
	return fixture;
}
const instance = createFixtureInstance('test-terminal');
const widgetServices = store.add(createCodeEditorServices(store).createChild());
widgetServices.registerInstance(IFileService, store.add(new FileService()));
widgetServices.registerInstance(IEditorService, {
	onDidActiveEditorChange: Event.None,
	onDidVisibleEditorsChange: Event.None,
	activeEditor: undefined,
	visibleEditors: [],
	activeEditorPane: undefined, visibleEditorPanes: [],
	openEditor: async () => { throw new Error('Terminal fixture does not open editors'); },
	save: async () => ({ success: true, editors: [] }),
	saveAll: async () => ({ success: true, editors: [] }),
	focusActiveEditor: () => { },
});
widgetServices.registerInstance(IConfigurationService, store.add(new WorkbenchConfigurationService()));
widgetServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
const themeService = store.add(new TestThemeService(darkColorTheme));
function setTerminalTestTheme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight', overrides?: Readonly<Record<string, string>>): void {
	const base = { dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[mode];
	themeService.setColorTheme(overrides ? createColorTheme({ id: 'terminal-test', label: 'Terminal test', colorScheme: base.colorScheme, baseTheme: base, colorOverrides: overrides }) : base);
}
if (new URLSearchParams(location.search).has('find') || new URLSearchParams(location.search).has('browser') || new URLSearchParams(location.search).has('panelLayout')) { store.add(bindTestColorTheme(themeService, document.body)); }
widgetServices.registerInstance(IThemeService, themeService);
widgetServices.registerInstance(ITerminalLogService, new NullLoggerService());
widgetServices.registerInstance(ITerminalConfigurationService, store.add(widgetServices.createInstance(TerminalConfigurationService)));
widgetServices.registerInstance(IHoverService, store.add(new HoverService(widgetServices.get(IConfigurationService), store.add(new BrowserContextViewService(document.body)), { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } })));
instance.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
const widget = instance.xterm!;
widget.setVisible(true);
if (new URLSearchParams(location.search).has('browser')) widget.element.style.height = '100%';
if (new URLSearchParams(location.search).has('deferredFocus')) {
	const root = document.createElement('section');
	root.id = 'terminal-deferred-focus';
	root.style.cssText = 'width:0;height:300px;overflow:hidden';
	document.body.append(root);
	for (const label of ['Focus source', 'Other focus target']) {
		const button = document.createElement('button');
		button.textContent = label;
		document.body.append(button);
	}
	const screen = store.add(widgetServices.createInstance(XtermTerminal, root, instance));
	screen.element.style.height = '100%';
	await screen.initialize({ cols: 80, rows: 24, vt: 'retained deferred output\r\n' });
	screen.setVisible(true);
	window.ashTerminalDeferredFocusIntegration = {
		focus: () => screen.focus(),
		reveal: () => { root.style.width = '600px'; screen.fit(); },
	};
}

let completion: Promise<void> | undefined;

window.ashTerminalIntegration = {
	configure: async (key, value) => { await widgetServices.get(IConfigurationService).updateValue(key, value); },
	options: () => ({ fontSize: widget.raw.options.fontSize, fontFamily: widget.raw.options.fontFamily, cursorStyle: widget.raw.options.cursorStyle, cursorBlink: widget.raw.options.cursorBlink, scrollback: widget.raw.options.scrollback, lineHeight: widget.raw.options.lineHeight, letterSpacing: widget.raw.options.letterSpacing, minimumContrastRatio: widget.raw.options.minimumContrastRatio }),
	theme: (mode, overrides) => {
		setTerminalTestTheme(mode, overrides);
		return { background: widget.raw.options.theme?.background, foreground: widget.raw.options.theme?.foreground, red: widget.raw.options.theme?.red };
	},
	snapshot: limit => widget.getBufferText(limit, new AbortController().signal),
	writes,
	binaryWrites,
	resizes,
	fit: () => widget.fit(),
	resize: (cols, rows) => widget.raw.resize(cols, rows),
	write: text => widget.write(text),
	sequence: async (event, text) => {
		if (text) await new Promise<void>(resolve => widget.write(text, resolve));
		widget.handleShellIntegration(event);
	},
	start: () => {
		void instance.xtermReadyPromise;
		completion = widget.initialize();
		widget.focus();
		return completion === widget.initialize();
	},
	ready: async () => { await completion; },
	dimensions: () => ({ cols: widget.raw.cols, rows: widget.raw.rows }),
	markers: () => [...widget.capabilities.get(TerminalCapability.PartialCommandDetection)?.commands ?? []].map(marker => marker.line),
	dispose: () => store.dispose(),
};

declare global {
	interface Window {
		ashTerminalDeferredFocusIntegration: { focus(): void; reveal(): void; };
		ashTerminalIntegration: {
			configure(key: string, value: unknown): Promise<void>;
			sequence(event: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent, text?: string): Promise<void>;
			options(): { fontSize?: number; fontFamily?: string; cursorStyle?: string; cursorBlink?: boolean; scrollback?: number; lineHeight?: number; letterSpacing?: number; minimumContrastRatio?: number; };
			theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight', overrides?: Readonly<Record<string, string>>): { background: string | undefined; foreground: string | undefined; red: string | undefined; };
			snapshot(limit: number): Promise<string | undefined>;
			readonly writes: readonly string[];
			readonly binaryWrites: readonly number[][];
			readonly resizes: readonly ITerminalDimensions[];
			fit(): void;
			resize(cols: number, rows: number): void;
			write(text: string): void;
			start(): boolean;
			ready(): Promise<void>;
			dimensions(): ITerminalDimensions;
			markers(): readonly number[];
			dispose(): void;
		};
	}
}

// The process boundary records Shell writes while the product keybinding service owns dispatch.
if (new URLSearchParams(location.search).has('shortcuts')) {
	const shortcutServices = store.add(widgetServices.createChild());
	const registry = new CommandRegistry();
	const order: unknown[] = [];
	store.add(registry.registerMany([
		CommandsRegistry.getCommands().get('runCommands')!,
		{ id: 'test.terminal.first', handler: async (_accessor, value) => { order.push(value); await Promise.resolve(); order.push('first finished'); } },
		{ id: 'test.terminal.second', handler: () => order.push('second') },
	]));
	const commands = store.add(new CommandService(shortcutServices, registry));
	shortcutServices.registerInstance(ICommandService, commands);
	shortcutServices.registerInstance(ILogService, new NullLoggerService());
	const notifications = store.add(new TestNotificationService());
	shortcutServices.registerInstance(INotificationService, notifications);
	const profiles = new UserDataProfileService();
	shortcutServices.registerInstance(IUserDataProfileService, profiles);
	const source = JSON.stringify([
		{ key: 'ctrl+alt+y', command: 'runCommands', args: { commands: [{ command: 'test.terminal.first', args: { source: 'shortcut' } }, 'test.terminal.second'] } },
		{ key: 'ctrl+alt+z', command: 'runCommands', args: { commands: ['test.terminal.first', 'test.terminal.missing', 'test.terminal.second'] } },
	]);
	shortcutServices.registerInstance(IFileService, {
		onDidChangeFiles: Event.None,
		readFile: async resource => ({ resource, content: source, revision: '1' }),
	} as IFileService);
	const layouts = store.add(new BrowserKeyboardLayoutService({ navigator }));
	const keybindings = store.add(shortcutServices.createInstance(WorkbenchKeybindingService, {
		ownerDocument: document, commandService: commands, commandRegistry: registry,
		contextKeyService: shortcutServices.get(IContextKeyService), keyboardLayoutService: layouts,
		registry: new KeybindingRegistry(),
	}));
	await keybindings.initialize();
	window.ashTerminalBatchIntegration = { order, errors: () => notifications.model.getNotifications().map(item => item.message) };
}

declare global {
	interface Window {
		ashTerminalBatchIntegration: { readonly order: readonly unknown[]; errors(): readonly string[]; };
	}
}

// Exercise the production pane with controlled process and workspace boundaries.
if (new URLSearchParams(location.search).has('pane') || new URLSearchParams(location.search).has('windows')) {
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	if (new URLSearchParams(location.search).has('menuWiring')) {
		await import('../../../src/ash/workbench/contrib/tasks/browser/abstractTaskService.js');
		await import('../../../src/ash/workbench/contrib/tasks/browser/taskService.js');
	}
	// Load the auxiliary editor harness only for its window scenario.
	const windowModules = new URLSearchParams(location.search).has('newWindow') ? await Promise.all([
		import('../../../src/ash/workbench/browser/parts/editor/editorPart.js'),
		import('../../../src/ash/workbench/browser/parts/editor/editorParts.js'),
		import('../../../src/ash/workbench/browser/parts/titlebar/titlebarPart.js'),
		import('../../../src/ash/workbench/services/auxiliaryWindow/browser/auxiliaryWindowService.js'),
		import('../../../src/ash/workbench/services/editor/browser/browserEditorService.js'),
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalEditorService.js'),
		import('../../../src/ash/workbench/test/common/testEditorServices.js'),
		import('../../../src/ash/platform/uriIdentity/common/uriIdentityService.js'),
	]) : undefined;
	// An existing instance retains its screen when the pane takes over its DOM.
	if (!new URLSearchParams(location.search).has('existing')) widget.dispose();
	const [{ TerminalViewPane }, { ContextKeyService }, { MenuService }, { CommandService }, { URI }] = await Promise.all([
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js'),
		import('../../../src/ash/platform/contextkey/browser/contextKeyService.js'),
		import('../../../src/ash/platform/actions/common/menuService.js'),
		import('../../../src/ash/workbench/services/commands/common/commandService.js'),
		import('../../../src/ash/base/common/uri.js'),
	]);
	const createPane = (root: HTMLElement): Window['ashTerminalPaneIntegration'] & { command(id: string, argument?: unknown): Promise<unknown>; dispose(): void; } => {
		const paneInstance = new URLSearchParams(location.search).has('windows') ? createFixtureInstance(`window-terminal-${nextFixtureInstance + 1}`) : instance;
		if (new URLSearchParams(location.search).has('browser')) { root.style.display = 'flex'; root.style.flexDirection = 'column'; }
		const lifetime = store.add(new DisposableStore());
		const visibility = lifetime.add(new Emitter<import('../../../src/ash/workbench/services/layout/browser/layoutService.js').WorkbenchPartVisibilityChangeEvent>());
		const workspaceChanged = lifetime.add(new Emitter<import('../../../src/ash/platform/workspace/common/workspace.js').IWorkspaceChangeEvent>());
		const created = lifetime.add(new Emitter<ITerminalInstance>());
		const instancesChanged = lifetime.add(new Emitter<void>());
		const activeChanged = lifetime.add(new Emitter<ITerminalInstance | undefined>());
		const disposed = lifetime.add(new Emitter<ITerminalInstance>());
		const cleared: number[] = [];
		const closed: number[] = [];
		const relaunched: number[] = [];
		const context = lifetime.add(new ContextKeyService());
		AppServerAvailableContext.bindTo(context).set(true);
		const services = lifetime.add(widgetServices.createChild());
		const commands = lifetime.add(new CommandService(services));
		services.registerInstance(ICommandService, commands);
		const menu = new MenuService(commands, context);
		services.registerInstance(IMenuService, menu);
		let visible = false;
		let selected = true;
		let editorParts: import('../../../src/ash/workbench/browser/parts/editor/editorParts.js').EditorParts | undefined;
		const menuEffects = { settings: [] as unknown[], tasks: [] as string[], editors: [] as string[] };
		let profiles = 0;
		let creates = 0;
		const createdProfiles: string[] = [];
		const launches: { profile: unknown; env: unknown; cwd: unknown; }[] = [];
		const availableProfiles = new URLSearchParams(location.search).has('profiles') ? [paneInstance.profile, { profileId: 'bash', title: 'Bash', isDefault: false }] : [paneInstance.profile];
		let release: (() => void) | undefined;
		let pending: Promise<void> = Promise.resolve();
		let instances: readonly ITerminalInstance[] = new URLSearchParams(location.search).has('existing') ? [paneInstance] : [];
		let integration = new URLSearchParams(location.search).get('shellIntegration');
		let metadataSequence = 0;
		let metadataCwd = '/backend/workspace';
		let metadataPrompt: string | undefined;
		const hoverOutput: { sequence: number; data: Uint8Array; shellIntegration?: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent; }[] = [];
		let activeInstance = instances.at(-1);
		const workspace = { id: 'workspace', folders: [{ id: 'workspace', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }] };
		const setPanel = (value: boolean): void => {
			visible = value;
			visibility.fire({ partId: 'panel', visible });
			pane.setVisible(visible && selected);
		};
		const legacyTerminals: ITerminalService = {
			importTerminalState: async () => { throw new Error('This fixture does not transfer terminals'); },
			confirmTerminalClose: async () => true,
			whenConnected: Promise.resolve(),
			safeDisposeTerminal: async instance => { await terminals.closeTerminal(instance); },
			...Disposable.None,
			instances,
			get activeInstance() { return activeInstance; },
			onDidCreateInstance: created.event,
			onDidDisposeInstance: disposed.event,
			onDidChangeInstances: instancesChanged.event,
			onDidChangeActiveInstance: activeChanged.event,
			createTerminal: async (options = {}) => {
				creates++;
				const profileId = options.profile?.type === 'profile' ? options.profile.profileId : undefined;
				const selected = options.profile?.type === 'custom' ? { profileId: `custom:${options.profile.name}`, title: options.profile.name, isDefault: false }
					: availableProfiles.find(profile => profile.profileId === profileId) ?? paneInstance.profile;
				createdProfiles.push(selected.profileId);
				launches.push({ profile: options.profile, env: options.env, cwd: options.cwd });
				const createdInstance = instances.length === 0 ? paneInstance : createFixtureInstance(`test-terminal-${creates}`);
				Object.assign(createdInstance, { profile: { ...selected, icon: options.icon, color: options.color }, title: selected.title, shellLaunchConfig: options.profile?.type === 'custom' ? { name: selected.title, executable: options.profile.path, args: options.profile.args, env: options.env, cwd: options.cwd } : undefined });
				(instances as ITerminalInstance[]).push(createdInstance);
				activeInstance = createdInstance;
				const clear = createdInstance.clearBuffer.bind(createdInstance);
				createdInstance.clearBuffer = () => { cleared.push(createdInstance.instanceId); clear(); };
				created.fire(createdInstance);
				instancesChanged.fire();
				return createdInstance;
			},
			relaunchTerminal: async instance => { relaunched.push(instance.instanceId); await pending; },
			setActiveInstance: instance => { activeInstance = instance; activeChanged.fire(instance); },
			moveTerminal: (instance, index) => { const current = instances.indexOf(instance); (instances as ITerminalInstance[]).splice(current, 1); (instances as ITerminalInstance[]).splice(index, 0, instance); instancesChanged.fire(); },
			closeTerminal: async instance => {
				closed.push(instance.instanceId); (instances as ITerminalInstance[]).splice(instances.indexOf(instance), 1);
				if (activeInstance === instance) activeInstance = instances.at(-1);
				disposed.fire(instance); activeChanged.fire(activeInstance); instancesChanged.fire();
			},
		};
		services.registerSingleton(ITerminalService, () => new URLSearchParams(location.search).has('existing') || new URLSearchParams(location.search).has('incoming') ? legacyTerminals : services.createInstance(TerminalService));
		let transcript!: (text: string, isFinal: boolean) => void;
		let stops = 0;
		services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(store, { getOptions: async () => ({ inputDevices: [], languages: [] }), start: async (_options, callback) => { transcript = callback; return { stop: async () => { stops++; }, cancel: async () => { stops++; } }; } }));
		services.registerInstance(IContextKeyService, context);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerInstance(IViewsService, { openView: () => pane, getViewWithId: () => pane, focusView: () => { pane.focus(); return true; } } as unknown as IViewsService);
		services.registerInstance(IPreferencesService, { openSettings: async (options: import('../../../src/ash/workbench/services/preferences/common/preferences.js').IOpenSettingsOptions) => { menuEffects.settings.push(options); } } as unknown as IPreferencesService);
		services.registerInstance(INotificationService, lifetime.add(new TestNotificationService()));
		services.registerInstance(IWorkspaceContextService, {
			onDidChangeWorkspace: workspaceChanged.event,
			onDidChangeWorkspaceFolders: Event.None,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceName: Event.None, getWorkspace: () => workspace, getWorkbenchState: () => 2, getWorkspaceFolder: resource => workspace.folders.find(folder => extUri.isEqualOrParent(resource, folder.uri)) ?? null
		});
		services.registerInstance(IConfigurationService, lifetime.add(new WorkbenchConfigurationService({ source: '{"dictation.backend":"cloud"}' })));
		services.registerInstance(ITerminalProcessService, {
			operatingSystem: new URLSearchParams(location.search).get('os') === 'windows' ? OperatingSystem.Windows : OperatingSystem.Linux,
			onConnectionState: Event.None, getConnectionState: async () => 'ready',
			listProfiles: async () => { profiles++; await pending; return availableProfiles; },
			getEnvironment: async () => ({ HOME: '/home/test', PROFILE_ARG: 'literal;$HOME' }),
			getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, cwd: '/backend/workspace', rows: 24, cols: 80 }),
			resolveProfile: async selection => ({ profile: selection.type === 'custom' ? { profileId: `custom:${selection.name}`, title: selection.name, isDefault: false } : availableProfiles.find(profile => selection.type === 'profile' && profile.profileId === selection.profileId) ?? paneInstance.profile, executable: selection.type === 'custom' ? selection.path.at(-1)! : '/bin/sh', args: selection.type === 'custom' ? (typeof selection.args === 'string' ? selection.args : [...selection.args]) : [] }),
			create: async options => {
				creates++;
				const selection = options.profile;
				const profile = selection.type === 'custom' ? { profileId: `custom:${selection.name}`, title: selection.name, isDefault: false }
					: availableProfiles.find(profile => selection.type === 'profile' && profile.profileId === selection.profileId) ?? paneInstance.profile;
				createdProfiles.push(profile.profileId);
				launches.push({ profile: selection, env: options.env, cwd: options.cwd });
				const terminalId = `pane-${creates}`;
				const hoverLaunch = new URLSearchParams(location.search).get('hoverLaunch');
				const launch = hoverLaunch ? {
					executable: hoverLaunch === 'windows' ? 'C:\\Program Files\\Fixture Shell\\bin\\pwsh.exe' : '/opt/fixture/a/long/path/to/a/shell/bin/bash',
					args: hoverLaunch === 'windows' ? '-NoExit -Command ". fixture.ps1"' : ['--rcfile', '/private/fixture bashrc', ''],
					usedShellIntegrationInjection: true,
				} : undefined;
				return { terminalId, ready: { pid: 1234 + creates, cwd: '/backend/workspace', shellType: integration ? PosixShellType.Bash : undefined, launch }, profile, connectionPersistence: 'connectionOwned' };
			},
			read: async options => {
				await new Promise(resolve => setTimeout(resolve, 10));
				return {
					terminalId: options.terminalId, chunks: hoverOutput.filter(chunk => chunk.sequence > options.afterSequence), nextSequence: metadataSequence, outputGap: false, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: new URLSearchParams(location.search).has('exited'), exitCode: undefined,
					cwd: integration ? { value: metadataCwd, isTrusted: true, afterOutputSequence: metadataSequence } : undefined,
					shellIntegration: integration ? { commandDetection: integration !== 'none', cwdDetection: true, hasRichCommandDetection: integration === 'rich', commandStorageDisabled: false, commands: [], promptType: metadataPrompt, afterOutputSequence: metadataSequence } : undefined
				};
			},
			write: async options => {
				if (new URLSearchParams(location.search).has('rejectInput') && options.data === 'hover-input') throw new Error('Synthetic input failure');
				if (typeof options.data === 'string' && !options.data.startsWith('\x1b[?')) writes.push(options.data);
			},
			resize: async () => { }, setAutoReplies: async () => { }, sendSignal: async () => { },
			close: async options => { closed.push(Number(options.terminalId.slice(5))); },
		});
		setupTerminalFixtureServices(services, lifetime, true, false);
		services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
		services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
		services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
		registerTestDictationOnboarding(services);
		const profileService = lifetime.add(services.createInstance(TerminalProfileService));
		services.registerInstance(ITerminalProfileService, profileService);
		const resolver = lifetime.add(services.createInstance(BrowserTerminalProfileResolverService));
		services.registerInstance(ITerminalProfileResolverService, resolver);
		if (new URLSearchParams(location.search).has('extensionProfiles')) {
			const digest = `sha256:${'a'.repeat(64)}`;
			const extension = services.get(IExtensionService);
			const bridge = lifetime.add(services.createInstance(MainThreadTerminalService));
			Object.assign(services.get(ITerminalContributionService), { terminalProfiles: [{ extensionIdentifier: 'acme.extension', id: 'shell', title: 'Extension Shell', options: { icon: { id: 'terminal-git-bash' }, color: 'terminal.ansiGreen' } }] });
			Object.assign(extension, {
				currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', packageSha256: digest }] },
				activateByEvent: async (event: string) => {
					if (event !== 'onTerminalProfile:shell') throw new Error(`Unexpected activation: ${event}`);
					bridge.replaceProfiles([{ runtimeId: 'extension-runtime', packageDigest: digest, profileId: 'shell', title: 'Extension Shell', invoke: async (operation): Promise<import('../../../src/ash/platform/agentHost/common/extensionHostApi.js').JsonValue> => operation === 'getTerminalEnvironment' ? { persistent: true, map: [] } : ({ options: { name: 'Extension Shell', shellPath: '${env:HOME}/extension-shell', shellArgs: ['${env:PROFILE_ARG}'], env: { EXTENSION: 'value' } } }) }]);
				},
			});
		}
		if (new URLSearchParams(location.search).has('menuWiring')) {
			const files = lifetime.add(new FileService());
			const provider = lifetime.add(new InMemoryFileSystemProvider());
			lifetime.add(files.registerProvider('file', provider));
			services.registerInstance(IFileService, files);
			services.registerInstance(IEditorService, {
				onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None,
				openEditor: async input => { menuEffects.editors.push(input.resource.toString()); },
			} as IEditorService);
			const catalog = [{ id: 'build', label: 'Build from terminal menu', command: 'build', source: 'vscode', group: 'build', dirId: 'workspace' }];
			services.registerInstance(ITaskService, {
				tasks: catalog, onDidChangeTasks: Event.None, refresh: async () => catalog,
				run: async (task: import('../../../src/ash/workbench/contrib/tasks/common/tasks.js').IWorkspaceTask) => { menuEffects.tasks.push(task.id); },
			} as unknown as ITaskService);
		}
		if (windowModules) {
			const [{ EditorPart }, { EditorParts, IEditorPartsService }, { AuxiliaryBrowserTitlebarPart }, { BrowserAuxiliaryWindowService }, { BrowserEditorService }, { TerminalEditorService }, { createTestEditorServices }, { UriIdentityService }] = windowModules;
			services.registerInstance(IUriIdentityService, lifetime.add(services.createInstance(UriIdentityService)));
			const editorServices = lifetime.add(createTestEditorServices(services.get(IConfigurationService), services));
			editorServices.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, fallback) => fallback });
			const host = document.createElement('div');
			document.body.append(host);
			lifetime.add(toDisposable(() => host.remove()));
			const main = lifetime.add(editorServices.createInstance(EditorPart, host, {}));
			const windows = lifetime.add(editorServices.createInstance(BrowserAuxiliaryWindowService, window, root));
			const parts = editorParts = lifetime.add(editorServices.createInstance(EditorParts, main, windows, (container: HTMLElement) => {
				const part = editorServices.createInstance(EditorPart, container, {});
				const titlebar = editorServices.createInstance(AuxiliaryBrowserTitlebarPart, container, 'Ash Code', part, () => { }, 'actions-only');
				container.prepend(titlebar.container);
				return { titlebar, part };
			}, editorServices.get(IAccessibilityService), editorServices.get(IStorageService)));
			const editors = lifetime.add(new BrowserEditorService(parts));
			services.registerInstance(IEditorPartsService, parts);
			services.registerInstance(IEditorService, editors);
			services.registerInstance(IEditorGroupsService, editors);

		}
		const terminals = services.get(ITerminalService);
		instances = terminals.instances;
		if (!new URLSearchParams(location.search).has('existing')) {
			const relaunch = terminals.relaunchTerminal.bind(terminals);
			terminals.relaunchTerminal = async (instance, dimensions) => { relaunched.push(instance.instanceId); await pending; return relaunch(instance, dimensions); };
		}
		lifetime.add(terminals.onDidCreateInstance(instance => {
			const clear = instance.clearBuffer.bind(instance);
			instance.clearBuffer = () => { cleared.push(instance.instanceId); clear(); };
		}));
		const paneLayout = Object.assign(lifetime.add(new BrowserLayoutService({ root })), {
			onDidChangePanelPosition: Event.None, getPanelPosition: () => Position.BOTTOM, setPanelPosition: () => { },
			getSideBarPosition: () => Position.LEFT,
			onDidChangePartVisibility: visibility.event,
			onDidChangeAuxiliaryBarMaximized: Event.None, isAuxiliaryBarMaximized: () => false,
			toggleMaximizedAuxiliaryBar: () => { }, setAuxiliaryBarMaximized: () => false,
			isPartVisible: () => visible,
			hasFocus: () => false,
			getVisibleNeighborPart: () => undefined,
			isPanelMaximized: () => false,
			toggleMaximizedPanel: () => { },
			showPart: () => setPanel(true),
			showParts: () => setPanel(true),
			hidePart: () => setPanel(false),
			hideParts: () => setPanel(false),
			getPartSize: () => ({ width: 800, height: 400 }),
			resizePart: () => { },
			setLayoutStyle: () => { },
		});
		services.registerInstance(IWorkbenchLayoutService, paneLayout);
		const pane = lifetime.add(new TerminalViewPane(root, { id: 'terminal', title: 'Terminal' }, terminals, paneLayout, {
			onDidChangeWorkspace: workspaceChanged.event,
			onDidChangeWorkspaceFolders: Event.None,
			onDidChangeWorkbenchState: Event.None,
			onDidChangeWorkspaceName: Event.None,
			getWorkspace: () => workspace,
			getWorkbenchState: () => 2,
			getWorkspaceFolder: resource => workspace.folders.find(folder => extUri.isEqualOrParent(resource, folder.uri)) ?? null,
		}, services, profileService, resolver, services.get(ITerminalProcessService), services.get(ITerminalGroupService), services.get(IWorkbenchEnvironmentService)));
		root.append(pane.partTitleProjection.actions!);
		pane.layout(Math.max(0, root.clientHeight - pane.partTitleProjection.actions!.offsetHeight), 0, root.clientWidth);
		return {
			configure: (key, value) => services.get(IConfigurationService).updateValue(key, value),
			theme: setTerminalTestTheme,
			metadata: (level, cwd, prompt) => { integration = level; metadataCwd = cwd; metadataPrompt = prompt; hoverOutput.push({ sequence: ++metadataSequence, data: new Uint8Array() }); },
			sequence: (event, text = '') => { hoverOutput.push({ sequence: ++metadataSequence, data: new TextEncoder().encode(text), shellIntegration: event }); },
			environment: enabled => enabled ? services.get(IEnvironmentVariableService).set('acme.environment', { persistent: false, map: new Map([['MODE', { variable: 'MODE', type: 1, value: 'extension' }]]) }) : services.get(IEnvironmentVariableService).delete('acme.environment'),
			newWindowState: () => ({ parts: editorParts?.parts.length, editors: editorParts?.editorsMru.map(editor => editor.input.resource.toString()), input: writes.join('') }),
			menuEffects: async () => ({ ...menuEffects, configuration: menuEffects.editors.length ? (await services.get(IFileService).readFile(URI.parse(menuEffects.editors.at(-1)!))).content : undefined }),
			createdProfiles: () => [...createdProfiles],
			launches: () => [...launches],
			defaultProfile: () => profileService.getDefaultProfile()?.profileId,
			operations: () => ({ cleared, closed, relaunched }),
			menuActions: () => {
				using menuContext = context.createScoped(root.ownerDocument.createElement('div'));
				TerminalActiveInstanceStateContext.bindTo(menuContext).set(terminals.activeInstance?.state ?? 'none');
				return menu.getMenuActions(MenuId.TerminalInstanceContext, undefined, menuContext).flatMap(([, actions]) => actions.map(action => action.label));
			},
			ids: () => instances.map(instance => instance.instanceId),
			activate: id => terminals.setActiveInstance(instances.find(instance => instance.instanceId === id)),
			activeId: () => terminals.activeInstance?.instanceId,
			snapshot: () => pane.getTerminalOutput(paneInstance, 100_000, new AbortController().signal),
			counts: () => ({ profiles, creates }),
			receive: async () => { await legacyTerminals.createTerminal(); },
			command: (id: string, argument?: unknown) => commands.executeCommand(id, argument),
			dispose: () => lifetime.dispose(),
			transcript: (text, final) => transcript(text, final),
			stops: () => stops,
			panel: setPanel,
			view: value => { selected = value; pane.setVisible(visible && selected); },
			expand: value => pane.setExpanded(value),
			focus: () => pane.focus(),
			workspace: () => workspaceChanged.fire({ previous: workspace, workspace }),
			hold: () => { pending = new Promise<void>(resolve => { release = resolve; }); },
			release: () => release?.(),
		};
	};
	if (new URLSearchParams(location.search).has('windows')) {
		widget.dispose();
		const panes = [0, 1].map(index => {
			const root = document.createElement('div');
			root.id = `window-${index}`;
			root.style.width = '640px';
			root.style.height = '320px';
			document.body.append(root);
			return createPane(root);
		});
		window.ashTerminalWindowsIntegration = panes;
	} else {
		window.ashTerminalPaneIntegration = createPane(document.querySelector<HTMLElement>('#terminal')!);
	}
}

declare global {
	interface Window {
		ashTerminalWindowsIntegration: readonly {
			panel(value: boolean): void;
			counts(): { profiles: number; creates: number; };
			command(id: string, argument?: unknown): Promise<unknown>;
			dispose(): void;
		}[];
		ashTerminalPaneIntegration: {
			configure(key: string, value: unknown): Promise<void>;
			metadata(level: 'none' | 'basic' | 'rich', cwd: string, prompt?: string): void;
			sequence(event: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent, text?: string): void;
			theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight', overrides?: Readonly<Record<string, string>>): void;
			environment(enabled: boolean): void;
			newWindowState(): { parts?: number; editors?: readonly string[]; input: string; };
			menuEffects(): Promise<{ settings: readonly unknown[]; tasks: readonly string[]; editors: readonly string[]; configuration?: string; }>;
			createdProfiles(): readonly string[];
			launches(): readonly { profile: unknown; env: unknown; cwd: unknown; }[];
			defaultProfile(): string | undefined;
			dispose(): void;
			command(id: string, argument?: unknown): Promise<unknown>;
			operations(): { cleared: readonly number[]; closed: readonly number[]; relaunched: readonly number[]; };
			menuActions(): readonly string[];
			ids(): readonly number[];
			activate(id: number): void;
			activeId(): number | undefined;
			snapshot(): Promise<string | undefined>;
			counts(): { profiles: number; creates: number; };
			receive(): Promise<void>;
			transcript(text: string, final: boolean): void;
			stops(): number;
			panel(visible: boolean): void;
			view(visible: boolean): void;
			expand(expanded: boolean): boolean;
			focus(): void;
			workspace(): void;
			hold(): void;
			release(): void;
		};
	}
}

if (new URLSearchParams(location.search).has('assembly')) {
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	const [{ InstantiationService }, { ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { TestWorkspaceService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/instantiationService.js'),
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/configuration/test/common/testServices.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
	]);
	window.ashTerminalAssemblyIntegration = async () => {
		using resources = new DisposableStore();
		const workspace = resources.add(new TestWorkspaceService({ id: 'assembly', uri: URI.file('/workspace') }));
		const calls: string[] = [];
		const written = new Set<string>();
		let nextProcess = 1;
		const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
			getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, cwd: '/backend/current', rows: 24, cols: 80 }),
			getConnectionState: async () => 'ready',
			onConnectionState: () => Disposable.None,
			setAutoReplies: async () => { }, sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [instance.profile],
			create: async () => {
				const terminalId = `backend-${nextProcess++}`;
				calls.push(`create:${terminalId}`);
				return { ready: { pid: 1234, cwd: '/backend/workspace' }, terminalId, profile: instance.profile, connectionPersistence: 'connectionOwned' };
			},
			write: async options => { calls.push(`write:${options.terminalId}:${options.data}`); written.add(options.terminalId); },
			resize: async options => { calls.push(`resize:${options.terminalId}:${options.rows}x${options.cols}`); },
			close: async options => { calls.push(`close:${options.terminalId}`); },
			read: async options => ({
				terminalId: options.terminalId,
				chunks: written.has(options.terminalId) ? [{ sequence: 1, data: new TextEncoder().encode('scope-output') }] : [],
				nextSequence: written.has(options.terminalId) ? 1 : 0,
				outputGap: false,
				commandEvents: [],
				nextCommandSequence: 0,
				commandEventGap: false,
				exited: written.has(options.terminalId),
				exitCode: written.has(options.terminalId) ? 0 : undefined,
			}),
		};
		const install = (container: import('../../../src/ash/platform/instantiation/common/instantiationService.js').InstantiationService): void => {
			container.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
			container.registerInstance(ICommandService, widgetServices.get(ICommandService));
			container.registerInstance(IEditorService, widgetServices.get(IEditorService));
			setupTerminalFixtureServices(container, resources, false);
			installWorkbenchServiceContributions({ container, register: value => resources.add(value), blockRestorationUntil: () => { } });
		};
		const services = [0, 1].map(() => {
			const container = resources.add(new InstantiationService(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace], [IConfigurationService, resources.add(new InMemoryConfigurationService())])));
			install(container);
			return container.get(ITerminalService);
		});
		const output: string[] = [];
		const exits: Promise<number | undefined>[] = [];
		for (const service of services) {
			resources.add(service.onDidCreateInstance(terminal => {
				resources.add(terminal.onDidWriteData(data => output.push(data.data)));
				exits.push(new Promise(resolve => resources.add(terminal.onDidExit(resolve))));
			}));
			const terminal = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			await terminal.sendText('input', false);
			terminal.resize({ rows: 30, cols: 90 });
		}
		await Promise.all(exits);
		const isolated = services[0].instances[0] !== services[1].instances[0];
		for (const service of services) { await service.closeTerminal(service.instances[0]); }
		let missingDependency = '';
		const missing = resources.add(widgetServices.createChild(new ServiceCollection([IWorkspaceContextService, workspace])));
		try { install(missing); }
		catch (error) { missingDependency = String(error); }
		return { isolated, output, calls, missingDependency, remaining: services.map(service => service.instances.length) };
	};
}

declare global {
	interface Window {
		ashTerminalAssemblyIntegration(): Promise<{ isolated: boolean; output: string[]; calls: string[]; missingDependency: string; remaining: number[]; }>;
	}
}

if (new URLSearchParams(location.search).has('embedder')) {
	widget.dispose();
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	const [{ IEmbedderTerminalService }, { TerminalMainContribution }, { getSingletonServiceDescriptors }, { ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { TestWorkspaceService }, { installWorkbenchServiceContributions }, { WorkbenchContributionsRegistry, WorkbenchPhase }] = await Promise.all([
		import('../../../src/ash/workbench/services/terminal/common/embedderTerminalService.js'),
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalMainContribution.js'),
		import('../../../src/ash/platform/instantiation/common/extensions.js'),
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/configuration/test/common/testServices.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
		import('../../../src/ash/workbench/common/contributions.js'),
	]);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IEmbedderTerminalService)![1];
	const workspace = store.add(new TestWorkspaceService({ id: 'host-output' }));
	const backendCalls: string[] = [];
	const rejectBackend = async (): Promise<never> => { backendCalls.push('unexpected'); throw new Error('Host output has no backend'); };
	const services = store.add(widgetServices.createChild(new ServiceCollection(
		[IEmbedderTerminalService, descriptor],
		[IWorkspaceContextService, workspace],
		[ITerminalProcessService, { getEnvironment: async () => ({}), listProfiles: rejectBackend, create: rejectBackend, write: rejectBackend, resize: rejectBackend, read: rejectBackend, getProcessInfo: rejectBackend, close: rejectBackend, getConnectionState: async () => 'crashed', onConnectionState: Event.None }],
	)));
	let hostWidget: import('../../../src/ash/workbench/contrib/terminal/browser/terminal.js').IXtermTerminal;
	let completeHost!: () => void;
	const hostReady = new Promise<void>(resolve => { completeHost = resolve; });
	services.registerInstance(IViewsService, {
		openView: async (_id: string) => {
			if (!hostWidget) {
				terminals.activeInstance!.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
				hostWidget = terminals.activeInstance!.xterm!;
				hostWidget.setVisible(true);
				await terminals.activeInstance!.xtermReadyPromise;
			}
			hostWidget.focus();
			completeHost();
			return null;
		},
	} as IViewsService);
	setupTerminalFixtureServices(services, store);
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	const hostOutput = store.add(new Emitter<string>());
	const hostExit = store.add(new Emitter<void | number>());
	const hostName = store.add(new Emitter<string>());
	let opens = 0;
	let closes = 0;
	services.get(IEmbedderTerminalService).createTerminal({
		name: 'Host output',
		pty: {
			onDidWrite: hostOutput.event, onDidClose: hostExit.event, onDidChangeName: hostName.event,
			open: () => { opens++; hostOutput.fire('synchronous host output\r\n'); },
			close: () => { closes++; },
		},
	});
	const contributions = store.add(WorkbenchContributionsRegistry.createHost(services, undefined, [TerminalMainContribution.ID]));
	contributions.advance(WorkbenchPhase.BlockRestore);
	const hostInstances = terminals.instances;
	window.ashEmbedderTerminalIntegration = {
		ready: async () => { await hostReady; },
		name: value => hostName.fire(value),
		output: value => hostOutput.fire(value),
		exit: code => hostExit.fire(code),
		status: () => ({ opens, closes, backendCalls, title: hostInstances.at(-1)?.title, state: hostInstances.at(-1)?.state, readOnly: hostInstances.at(-1)?.isReadOnly, remaining: hostInstances.length }),
		close: async () => { await terminals.activeInstance!.close(); store.dispose(); },
		dispose: () => store.dispose(),
	};
}

declare global {
	interface Window {
		ashEmbedderTerminalIntegration: {
			ready(): Promise<void>;
			name(value: string): void;
			output(value: string): void;
			exit(code: number): void;
			status(): { opens: number; closes: number; backendCalls: string[]; title?: string; state?: string; readOnly?: boolean; remaining: number; };
			close(): Promise<void>;
			dispose(): void;
		};
	}
}

if (new URLSearchParams(location.search).has('stream')) {
	widget.dispose();
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	const [{ ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { TestWorkspaceService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/configuration/test/common/testServices.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
	]);
	const reads: number[] = [];
	const events: string[] = [];
	const streamInputWrites: string[] = [];
	let closes = 0;
	const bytes = new TextEncoder().encode('中文🙂\r\n');
	const reportCwd = new URLSearchParams(location.search).has('cwd');
	const reportHistory = new URLSearchParams(location.search).has('history');
	const reuseCommands = new URLSearchParams(location.search).has('reuseCommands');
	const commandModel = new URLSearchParams(location.search).has('commandModel');
	const reviveHistory = new URLSearchParams(location.search).has('reviveHistory');
	let modelSequence = 0;
	const modelOutput: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessOutputChunk[] = [];
	const queueModel = (data: string, shellIntegration?: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent) => {
		modelOutput.push({ sequence: ++modelSequence, data: new TextEncoder().encode(data), ...(shellIntegration ? { shellIntegration } : {}) });
	};
	if (reviveHistory) {
		queueModel('', { type: 'processReady', isWindowsPty: true, shellType: GeneralShellType.PowerShell });
		queueModel('', { type: 'promptStart' });
		queueModel('', { type: 'commandStart' });
		// ConsoleHost's first console paint follows the shell's prompt metadata.
		// Fragment the reset to exercise the real parser rather than text replacement.
		queueModel('\x1b[?25l\x1b[2');
		queueModel('J\x1b[3J\x1b[m\x1b[HPS NEW> ');
		queueModel('\x1b[?25h');
	} else if (commandModel) {
		const powerShell = new URLSearchParams(location.search).has('powerShell');
		queueModel('', { type: 'processReady', isWindowsPty: powerShell, shellType: powerShell ? GeneralShellType.PowerShell : PosixShellType.Bash });
		queueModel('', { type: 'promptStart' });
		queueModel('$ ');
		queueModel('', { type: 'commandStart' });
		queueModel('echo 中文🙂\r\n');
		queueModel('', { type: 'commandExecuted', commandId: 'model-command', command: 'echo 中文🙂', isTrusted: true, cwd: '/workspace', timestampMillis: 123 });
		queueModel('result 中文🙂\r\n');
		queueModel('', { type: 'commandFinished', exitCode: 0, durationMillis: 25 });
		queueModel('', { type: 'promptStart' });
		queueModel('$ ');
		queueModel('', { type: 'commandStart' });
	}
	let launch = 0;
	const overflow = new URLSearchParams(location.search).has('overflow');
	// This scenario observes the display-history cap independently of xterm's configurable scrollback.
	if (overflow) await widgetServices.get(IConfigurationService).updateValue('terminal.integrated.scrollback', 5000);
	const profile = { profileId: 'shell', title: 'Shell', isDefault: true };
	const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
		operatingSystem: reviveHistory || new URLSearchParams(location.search).get('os') === 'windows' ? OperatingSystem.Windows : undefined,
		getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/workspace' }, cwd: '/workspace/current', rows: 24, cols: 80 }),
		setAutoReplies: async () => { }, sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [profile],
		create: async () => { launch++; return { terminalId: reuseCommands ? `stream-shell-${launch}` : 'stream-shell', ready: { pid: reuseCommands ? 1234 + launch : 1234, cwd: '/workspace' }, profile, connectionPersistence: 'connectionOwned' }; },
		write: async options => {
			if (typeof options.data === 'string') streamInputWrites.push(options.data);
			if (commandModel && typeof options.data === 'string') queueModel(options.data);
		},
		resize: async () => { },
		close: async () => { closes++; },
		getConnectionState: async () => 'ready',
		onConnectionState: Event.None,
		read: async options => {
			reads.push(options.afterSequence);
			if (commandModel) {
				const chunks = modelOutput.filter(chunk => chunk.sequence > options.afterSequence).slice(0, options.maxChunks);
				return { terminalId: options.terminalId, chunks, nextSequence: chunks.at(-1)?.sequence ?? options.afterSequence, outputGap: false, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: false, exitCode: undefined };
			}
			const first = options.afterSequence === 0;
			const status = reuseCommands && launch > 1 ? 'failed' as const : 'succeeded' as const;
			const code = reuseCommands && launch > 1 ? 11 : 0;
			return {
				terminalId: options.terminalId,
				chunks: overflow ? Array.from({ length: Math.min(options.maxChunks, 4100 - options.afterSequence) }, (_, offset) => {
					const index = options.afterSequence + offset;
					// Exercise the byte limit even when the input owner coalesces a read
					// page. Formatting bytes keep visible rows short enough to inspect.
					return { sequence: index + 1, data: new TextEncoder().encode(`${'\x1b[0m'.repeat(64)}line-${index}\r\n`) };
				}) : [{
					sequence: first ? 1 : 2, data: first ? bytes.slice(0, 2) : bytes.slice(2), ...((reuseCommands || reportHistory) ? {
						shellIntegration: first
							? { type: 'commandExecuted' as const, commandId: 'command', command: 'echo 中文; printf \"quoted\"', isTrusted: true, cwd: '/workspace', timestampMillis: 123 }
							: { type: 'commandFinished' as const, exitCode: code, durationMillis: 25 }
					} : {})
				}],
				nextSequence: overflow ? Math.min(4100, options.afterSequence + options.maxChunks) : first ? 1 : 2,
				outputGap: false,
				commandEvents: options.afterCommandSequence === 0 ? [{ sequence: 1, commandId: 'command', status, exitCode: code, afterOutputSequence: 2, ...(reportCwd ? { cwd: '/workspace' } : {}), ...(reportHistory ? { command: 'echo 中文; printf \"quoted\"', isTrusted: true } : {}) }] : [],
				nextCommandSequence: 1,
				commandEventGap: false,
				exited: overflow || !first,
				exitCode: overflow || !first ? code : undefined,
				...(reportCwd ? { cwd: { value: '/workspace/changed; directory', isTrusted: true, afterOutputSequence: 2 } } : {}),
				...(reportHistory ? { shellIntegration: { commandDetection: true, cwdDetection: true, hasRichCommandDetection: true, commandStorageDisabled: false, commands: [{ sequence: 1, commandId: 'command', status: 'succeeded' as const, exitCode: 0, afterOutputSequence: 2, cwd: '/workspace', command: 'echo 中文; printf \"quoted\"', isTrusted: true }], afterOutputSequence: 2 } } : {}),
			};
		},
	};
	const workspace = store.add(new TestWorkspaceService({ id: 'stream', uri: URI.file('/workspace') }));
	const services = store.add(widgetServices.createChild(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	setupTerminalFixtureServices(services, store);
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	if (reviveHistory) {
		const snapshot: import('../../../src/ash/workbench/services/terminal/common/terminal.js').ITerminalSerializedState = {
			instanceId: 7, resource: getTerminalUri('previous-window', 7).toString(), dirId: workspace.getWorkspace().folders[0]!.id,
			process: { terminalId: 'previous-shell', ready: { pid: 321, cwd: '/workspace' }, profile, connectionPersistence: 'reconnectable' },
			title: 'PowerShell', target: TerminalLocation.Panel, cols: 80, rows: 24, sequence: 88, pendingUtf8: [],
			vt: 'SAVED_HISTORY\r\nold-command-complete\r\n', cwd: '/workspace',
			launch: { profile: { type: 'custom', name: 'PowerShell', path: ['powershell.exe'], args: [] }, cwd: '/workspace' },
		};
		services.get(IStorageService).store(TerminalStorageKeys.Revive, JSON.stringify({ version: 1, kind: 'revive', workspaceId: workspace.getWorkspace().id, instances: [snapshot], groups: [{ ids: [7], sizes: [1] }], activeId: 7 }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
	const terminals = services.get(ITerminalService);
	let screen: import('../../../src/ash/workbench/contrib/terminal/browser/terminal.js').IXtermTerminal | undefined;
	const deferred = new URLSearchParams(location.search).has('deferred');
	const observed: string[] = [];
	store.add(terminals.onDidCreateInstance(instance => {
		store.add(instance.onDidWriteData(event => observed.push(event.data)));
		if (!deferred) {
			instance.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
			screen = instance.xterm!;
			screen.setVisible(!new URLSearchParams(location.search).has('hidden'));
		}
		store.add(instance.onDidChangeCommandStatus(event => events.push(event.status)));
		store.add(instance.onDidExit(() => events.push('exit')));
	}));
	const terminal = reviveHistory ? (await terminals.whenConnected, terminals.instances[0]!) : await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	if (reviveHistory) terminal.start();
	const streamInstances = terminals.instances;
	window.ashTerminalStreamIntegration = {
		status: () => ({ reads, events, closes, state: terminal.state, remaining: streamInstances.length, ...(reportCwd ? { cwd: terminal.cwd } : {}), ...(reportHistory ? { shellIntegration: terminal.shellIntegration } : {}) }),
		reuse: async () => { await terminal.reuseTerminal({ executable: '/bin/sh', args: [], deferStart: true }); terminal.start(); },
		start: async () => {
			terminal.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
			screen = terminal.xterm!;
			if (reviveHistory) screen.element.style.height = '100%';
			screen.setVisible(true);
			await terminal.xtermReadyPromise; screen.focus();
		},
		feedModel: text => queueModel(text),
		environmentFrame: event => queueModel('', event),
		environment: () => terminal.capabilities?.get(TerminalCapability.ShellEnvDetection)?.env,
		serializeModel: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.serialize(),
		commandStartContents: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.commands.map(command => command.commandStartLineContent),
		restoreModel: value => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.deserialize(value),
		clearModel: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.clearCommands(),
		quickFix: {
			command: async () => services.invokeFunction(CommandsRegistry.getCommand('workbench.action.terminal.showQuickFixes')!),
			writes: () => [...streamInputWrites],
		},
		stickyScroll: {
			theme: setTerminalTestTheme,
			configure: (key, value) => services.get(IConfigurationService).updateValue(`terminal.integrated.stickyScroll.${key}`, value),
			toggle: async () => services.invokeFunction(CommandsRegistry.getCommand('workbench.action.terminal.toggleStickyScroll')!),
			scroll: line => screen!.raw.scrollToLine(line),
			position: () => ({ viewport: screen!.raw.buffer.active.viewportY, rows: screen!.raw.rows, cols: screen!.raw.cols }),
			resize: (cols, rows) => screen!.raw.resize(cols, rows),
			focus: () => screen!.focus(),
		},
		model: () => {
			const capability = terminal.capabilities!.get(TerminalCapability.CommandDetection);
			return { input: capability?.promptInputModel.getCombinedString(), state: capability?.promptInputModel.state, commands: capability?.commands.map(command => ({ id: command.id, text: command.command, output: command.getOutput(), timestamp: command.timestamp, duration: command.duration, trust: command.isTrusted, promptRows: command.getPromptRowCount(), commandRows: command.getCommandRowCount() })) };
		},
		observed: () => observed.join(''),
		snapshot: () => screen?.getBufferText(100_000, new AbortController().signal) ?? Promise.resolve(undefined),
		close: async () => { await terminal.close(); store.dispose(); },
	};
}

declare global {
	interface Window {
		ashTerminalStreamIntegration: {
			reuse(): Promise<void>;
			status(): { reads: number[]; events: string[]; closes: number; state: string; remaining: number; cwd?: string; shellIntegration?: import('../../../src/ash/workbench/contrib/terminal/browser/terminal.js').ITerminalShellIntegration; };
			feedModel(text: string): void;
			environmentFrame(event: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent): void;
			environment(): import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').TerminalShellIntegrationEnvironment | undefined;
			serializeModel(): import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').ISerializedCommandDetectionCapability;
			commandStartContents(): (string | undefined)[];
			restoreModel(value: import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').ISerializedCommandDetectionCapability): void;
			clearModel(): void;
			quickFix: { command(): Promise<unknown>; writes(): string[]; };
			stickyScroll: {
				theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight'): void;
				configure(key: 'enabled' | 'maxLineCount' | 'ignoredCommands', value: boolean | number | string[]): Promise<void>;
				toggle(): Promise<unknown>;
				scroll(line: number): void;
				position(): { viewport: number; rows: number; cols: number; };
				resize(cols: number, rows: number): void;
				focus(): void;
			};
			model(): { input: string | undefined; state: number | undefined; commands: { id: string | undefined; text: string; output: string | undefined; timestamp: number; duration: number; trust: boolean; promptRows: number; commandRows: number; }[] | undefined; };
			observed(): string;
			snapshot(): Promise<string | undefined>;
			start(): Promise<void>;
			close(): Promise<void>;
		};
	}
}

if (new URLSearchParams(location.search).has('input')) {
	widget.dispose();
	if (new URLSearchParams(location.search).has('clipboardFirst')) {
		await import('../../../src/ash/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.js');
	}
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	const [{ ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { TestWorkspaceService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/configuration/test/common/testServices.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
	]);
	const clipboardFixture = new URLSearchParams(location.search).has('clipboard');
	const sequenceFixture = new URLSearchParams(location.search).has('sequence');
	const groupFixture = new URLSearchParams(location.search).has('groups');
	let clipboardText = '';
	const copied: string[] = [];
	let clipboardReads = 0;
	let holdRead = false;
	let releaseRead: ((text: string) => void) | undefined;
	let rejectRead: (() => void) | undefined;
	let pasteOperation: Promise<unknown> | undefined;
	let pasteFinished = false;
	let holdInput = false;
	let releaseInput: ((failed: boolean) => void) | undefined;
	let nextTerminal = 0;
	if (clipboardFixture) {
		widgetServices.registerInstance(IClipboardService, store.add(new BrowserClipboardService({
			readText: async () => {
				clipboardReads++;
				if (!holdRead) return clipboardText;
				holdRead = false;
				return new Promise<string>((resolve, reject) => { releaseRead = resolve; rejectRead = () => reject(new Error('Clipboard access denied')); });
			},
			writeText: async (text: string) => { copied.push(text); },
		} as Clipboard)));
	}
	const connectionChanged = store.add(new Emitter<import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessConnectionState>());
	const writes: Array<string | number[]> = [];
	const routedWrites: { terminalId: string; data: string | number[]; }[] = [];
	const closedProcesses: string[] = [];
	const launchDirectories: (string | undefined)[] = [];
	const sizes: { terminalId: string; cols: number; rows: number; }[] = [];
	const queuedOutput: { data: Uint8Array; shellIntegration?: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent; }[] = [{ data: new TextEncoder().encode('retained screen\r\n\x1b[c') }];
	const directedOutput = new Map<string, { data: Uint8Array; }[]>();
	const processPids = new Map<string, number>();
	let sequence = 0;
	const profile = { profileId: 'shell', title: 'Shell', isDefault: true };
	const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
		operatingSystem: OperatingSystem.Linux,
		getProcessInfo: async options => ({ ready: { pid: processPids.get(options.terminalId) ?? 1234, cwd: '/workspace' }, cwd: '/workspace/current', rows: 24, cols: 80 }),
		setAutoReplies: async () => { }, sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [profile],
		create: async options => {
			launchDirectories.push(options.cwd);
			const terminalId = `input-shell-${++nextTerminal}`;
			const pid = new URLSearchParams(location.search).has('osc99') ? 1234 + nextTerminal : 1234;
			processPids.set(terminalId, pid);
			return { terminalId, ready: { pid, cwd: '/workspace', shellType: PosixShellType.Bash }, profile, connectionPersistence: 'connectionOwned' };
		},
		write: async options => {
			writes.push(typeof options.data === 'string' ? options.data : [...options.data]);
			routedWrites.push({ terminalId: options.terminalId, data: typeof options.data === 'string' ? options.data : [...options.data] });
			if (holdInput) {
				holdInput = false;
				await new Promise<void>((resolve, reject) => { releaseInput = failed => failed ? reject(new Error('Terminal write denied')) : resolve(); });
			}
		},
		resize: async options => { sizes.push({ terminalId: options.terminalId, cols: options.cols, rows: options.rows }); }, close: async options => { closedProcesses.push(options.terminalId); }, getConnectionState: async () => 'ready', onConnectionState: connectionChanged.event,
		read: async options => ({
			terminalId: options.terminalId, chunks: [...queuedOutput.splice(0), ...(directedOutput.get(options.terminalId)?.splice(0) ?? [])].map(chunk => ({ sequence: ++sequence, ...chunk })), nextSequence: sequence,
			outputGap: false, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: false, exitCode: undefined,
			...(currentDirectory ? {
				cwd: { value: currentDirectory, isTrusted: true, afterOutputSequence: sequence },
				shellIntegration: { commandDetection: false, cwdDetection: true, hasRichCommandDetection: false, commandStorageDisabled: false, commands: [], afterOutputSequence: sequence },
			} : {}),
		}),
	};
	let currentDirectory: string | undefined;
	const workspace = store.add(new TestWorkspaceService({ id: 'input', uri: URI.file('/workspace') }));
	const services = store.add(widgetServices.createChild(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	const notifications = store.add(new TestNotificationService());
	services.registerInstance(INotificationService, notifications);
	let groupPane: import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js').TerminalViewPane | undefined;
	if (groupFixture) {
		// Quick Access constructs its providers in this window's terminal scope.
		// The parent fixture's input service has an independent editor-only scope.
		const { TestQuickInputService } = await import('../../../src/ash/platform/quickinput/test/browser/testQuickInputService.js');
		services.registerInstance(IQuickInputService, store.add(new TestQuickInputService({
			container: document.body, instantiationService: services, contextKeyService: services.get(IContextKeyService),
		})));
	}
	// Contributions are constructed with the first instance, before the optional pane.
	services.registerInstance(IViewsService, {
		openView: async (id: string) => {
			if (id !== TERMINAL_VIEW_ID) return null;
			groupPane?.setVisible(true);
			groupPane?.focus();
			return groupPane ?? null;
		},
		getViewWithId: (id: string) => id === TERMINAL_VIEW_ID ? groupPane ?? null : null,
	} as unknown as IViewsService);
	setupTerminalFixtureServices(services, store, true, !new URLSearchParams(location.search).has('panelLayout'));
	let paneHost = document.querySelector<HTMLElement>('#terminal')!;
	let panelLayout: WorkbenchLayout | undefined;
	if (new URLSearchParams(location.search).has('panelLayout')) {
		await import('../../../src/ash/workbench/browser/media/style.css');
		const root = document.querySelector<HTMLElement>('#terminal')!;
		root.style.width = '1000px'; root.style.height = '700px';
		services.registerInstance(IAuxiliaryWindowService, store.add(services.createInstance(BrowserAuxiliaryWindowService, window, root)));
		panelLayout = store.add(services.createInstance(WorkbenchLayout, root, { workbenchState: WorkbenchState.FOLDER, initialDimension: new Dimension(1000, 700), defaultLayout: { parts: { panel: true } } }));
		services.registerInstance(IWorkbenchLayoutService, panelLayout);
		class FixturePart extends Part {
			constructor(private readonly partId: WorkbenchPartId) { super(root, partId, themeService, services.get(IStorageService)); }
			get content(): HTMLElement { return this.contentDomNode; }
			override get minimumHeight(): number { return this.partId === 'panel' ? 180 : 0; }
			override layout(dimension: IDimension): void {
				if (this.partId === 'panel') groupPane?.layout(dimension.height, 0, dimension.width);
			}
			override setVisible(visible: boolean): void {
				super.setVisible(visible);
				if (this.partId === 'panel') groupPane?.setVisible(visible);
			}
		}
		const parts = new Map<WorkbenchPartId, Part>();
		for (const id of workbenchPartIds) parts.set(id, store.add(new FixturePart(id)));
		paneHost = (parts.get('panel') as FixturePart).content;
		panelLayout.createParts(parts);
		await import('../../../src/ash/workbench/browser/parts/panel/panelActions.js');
	}
	if (clipboardFixture || new URLSearchParams(location.search).has('editor')) {
		const dialogs = services.get(IDialogService) as DialogService;
		store.add(new DialogHandlerContribution(dialogs.model, new BrowserDialogHandler(document.body)));
	}
	// Constructor-injected services must be installed before the first terminal's
	// contributions are created; replacing this service afterwards only fixes actions.
	const suggestFiles = new URLSearchParams(location.search).has('suggest') ? (() => {
		let holdFiles = false;
		let releaseFiles: (() => void) | undefined;
		const provider = store.add(new class extends InMemoryFileSystemProvider {
			override async readDirectory(resource: URI) {
				if (holdFiles) {
					holdFiles = false;
					await new Promise<void>(resolve => { releaseFiles = resolve; });
				}
				return super.readDirectory(resource);
			}
		}());
		const files = store.add(new FileService());
		store.add(files.registerProvider('file', provider));
		services.registerInstance(IFileService, files);
		return { files, provider, holdFiles: () => { holdFiles = true; }, filesPending: () => releaseFiles !== undefined, releaseFiles: () => { releaseFiles?.(); releaseFiles = undefined; } };
	})() : undefined;
	if (new URLSearchParams(location.search).has('accessibilityHelp')) {
		const { AccessibleViewService } = await import('../../../src/ash/workbench/contrib/accessibility/browser/accessibleView.js');
		await import('../../../src/ash/workbench/contrib/accessibility/browser/accessibleViewActions.js');
		services.registerSingleton(IAccessibleViewService, () => services.createInstance(AccessibleViewService));
	}
	const inputCommands = store.add(new CommandService(services));
	services.registerInstance(ICommandService, inputCommands);
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	store.add(terminals.onDidCreateInstance(instance => {
		instance.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
		if (new URLSearchParams(location.search).has('find') || clipboardFixture || sequenceFixture || groupFixture) {
			instance.xterm!.setVisible(true);
			instance.xterm!.focus();
		}
	}));
	const terminal = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	const screen = (await terminal.xtermReadyPromise)!;
	screen.setVisible(true);
	screen.focus();
	if (new URLSearchParams(location.search).has('find') || clipboardFixture || sequenceFixture || groupFixture) {
		const commands = inputCommands;
		if (!new URLSearchParams(location.search).has('accessibilityHelp')) services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		const keybindingSource = sequenceFixture ? JSON.stringify([
			{ key: 'ctrl+alt+y', command: 'workbench.action.terminal.sendSequence', args: { text: '\u001b[1;5D${workspaceFolder}' }, when: 'terminalFocus' },
		]) : '[]';
		if (new URLSearchParams(location.search).has('suggest')) {
			const { TerminalCommandHistory } = await import('../../../src/ash/workbench/contrib/terminalContrib/history/common/history.js');
			const { files, provider, holdFiles, filesPending, releaseFiles } = suggestFiles!;
			const keybindingsResource = services.get(IUserDataProfileService).currentProfile.keybindingsResource;
			store.add(files.registerProvider(keybindingsResource.scheme, provider));
			await files.createDirectory(URI.file('/workspace'));
			await files.createDirectory(URI.joinPath(keybindingsResource, '..'));
			await files.writeFile({ resource: keybindingsResource, content: keybindingSource }, { create: true, overwrite: true });
			const history = new TerminalCommandHistory(services.get(IConfigurationService), services.get(IStorageService));
			const { ITerminalCompletionService } = await import('../../../src/ash/workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js');
			const providerRequests: { value: string; cursorIndex: number; signal: AbortSignal; }[] = [];
			let providerRegistration: import('../../../src/ash/base/common/lifecycle.js').IDisposable | undefined;
			let releaseProvider: (() => void) | undefined;
			let releaseActivation: (() => void) | undefined;
			let activationSignal: AbortSignal | undefined;
			store.add(toDisposable(() => { providerRegistration?.dispose(); releaseProvider?.(); releaseActivation?.(); }));
			window.ashTerminalSuggestIntegration = {
				holdActivation: () => {
					const extensions = services.get(IExtensionService);
					const activate = extensions.activateByEvent.bind(extensions);
					const pending = new Promise<void>(resolve => { releaseActivation = resolve; });
					extensions.activateByEvent = async (event, signal) => {
						if (event !== 'onTerminal:terminalCompletionProvider') return activate(event, signal);
						if (signal) activationSignal ??= signal;
						await pending;
					};
					store.add(toDisposable(() => { extensions.activateByEvent = activate; }));
				},
				activationCancelled: () => activationSignal?.aborted,
				releaseActivation: () => { releaseActivation?.(); releaseActivation = undefined; },
				configure: (key, value) => services.get(IConfigurationService).updateValue(key, value),
				history: (command, trusted = true, disabled = false) => history.record(terminal.profile.profileId, 'succeeded', command, trusted, disabled),
				file: async path => { await files.createFile(URI.from({ scheme: 'file', path }), 'overwrite'); },
				directory: async path => { await files.createDirectory(URI.from({ scheme: 'file', path })); },
				holdFiles, filesPending, releaseFiles,
				model: () => terminal.capabilities?.get(TerminalCapability.CommandDetection)?.promptInputModel.getCombinedString(),
				provider: (items, triggers = [], delayed = false) => {
					providerRegistration?.dispose();
					providerRegistration = services.get(ITerminalCompletionService).registerTerminalCompletionProvider('fixture.extension', 'completion', {
						provideCompletions: async (_instance, value, cursorIndex, signal) => {
							providerRequests.push({ value, cursorIndex, signal });
							if (delayed) await new Promise<void>(resolve => { releaseProvider = resolve; });
							return items;
						},
					}, ...triggers);
				},
				providerRequests: () => providerRequests.map(({ value, cursorIndex, signal }) => ({ value, cursorIndex, cancelled: signal.aborted })),
				releaseProvider: () => { releaseProvider?.(); releaseProvider = undefined; },
				disposeProvider: () => { providerRegistration?.dispose(); providerRegistration = undefined; },
			};
		} else {
			services.registerInstance(IFileService, { onDidChangeFiles: Event.None, readFile: async resource => ({ resource, content: keybindingSource, revision: '1' }) } as IFileService);
		}
		const layouts = store.add(new BrowserKeyboardLayoutService({ navigator }));
		const keybindings = store.add(services.createInstance(WorkbenchKeybindingService, {
			ownerDocument: document, commandService: commands, contextKeyService: services.get(IContextKeyService), keyboardLayoutService: layouts,
		}));
		await keybindings.initialize();
		if (groupFixture) {
			const [{ TerminalViewPane }, { IWorkbenchLayoutService }, { MenuService }] = await Promise.all([
				import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js'),
				import('../../../src/ash/workbench/services/layout/browser/layoutService.js'),
				import('../../../src/ash/platform/actions/common/menuService.js'),
			]);
			const root = document.querySelector<HTMLElement>('#terminal')!;
			root.style.display = 'flex'; root.style.flexDirection = 'column';
			services.registerSingleton(ISpeechService, () => services.createInstance(SpeechService));
			services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
			services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
			services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(store, { getOptions: async () => ({ inputDevices: [], languages: [] }), start: async () => ({ stop: async () => { }, cancel: async () => { } }) }));
			registerTestDictationOnboarding(services);
			await services.get(IConfigurationService).updateValue('dictation.backend', 'cloud');
			services.registerInstance(IPreferencesService, { openSettings: async () => { } } as unknown as IPreferencesService);

			services.registerInstance(IMenuService, new MenuService(commands, services.get(IContextKeyService)));

			groupPane = store.add(services.createInstance(TerminalViewPane, paneHost, { id: 'ash.terminal', title: 'Terminal' }));
			groupPane.setVisible(true); groupPane.setExpanded(true);
			if (panelLayout) panelLayout.layout(new Dimension(1000, 700));
			else groupPane.layout(root.clientHeight, 0, root.clientWidth);
			if (new URLSearchParams(location.search).has('editor')) {
				// Individual scenarios enable the shared confirmation policy when testing close preflight.
				await services.get(IConfigurationService).updateValue('terminal.integrated.confirmOnKill', 'never');
				const [{ EditorPart }, { BrowserEditorService }, { IEditorService }, { IEditorGroupsService }, { TestUriIdentityServices }, { IUriIdentityService }] = await Promise.all([
					import('../../../src/ash/workbench/browser/parts/editor/editorPart.js'),
					import('../../../src/ash/workbench/services/editor/browser/browserEditorService.js'),
					import('../../../src/ash/workbench/services/editor/common/editorService.js'),
					import('../../../src/ash/workbench/services/editor/common/editorGroupsService.js'),
					import('../../../src/ash/platform/uriIdentity/test/common/uriIdentityTestServices.js'),
					import('../../../src/ash/platform/uriIdentity/common/uriIdentity.js'),
				]);
				const identities = store.add(new TestUriIdentityServices());
				services.registerInstance(IUriIdentityService, identities.get(IUriIdentityService));
				const editorHost = document.createElement('div');
				editorHost.style.height = '300px';
				root.append(editorHost);
				const { createTestEditorServices } = await import('../../../src/ash/workbench/test/common/testEditorServices.js');
				const editorServices = store.add(createTestEditorServices(services.get(IConfigurationService), services));
				const part = store.add(editorServices.createInstance(EditorPart, editorHost, { configurationService: services.get(IConfigurationService) }));
				part.layout({ width: 900, height: 300 });
				const editors = store.add(new BrowserEditorService(part));
				services.registerInstance(IEditorService, editors);
				services.registerInstance(IEditorGroupsService, editors);
				const [{ ITerminalEditorService }, { TerminalEditorService }] = await Promise.all([
					import('../../../src/ash/workbench/contrib/terminal/browser/terminal.js'),
					import('../../../src/ash/workbench/contrib/terminal/browser/terminalEditorService.js'),
				]);
				if (new URLSearchParams(location.search).has('extensionProfiles')) {
					const digest = `sha256:${'a'.repeat(64)}`;
					Object.assign(services.get(IExtensionService), { currentCatalog: { generation: 1, diagnostics: [], extensions: [{ id: 'acme.extension', packageSha256: digest }] } });
					const bridge = store.add(services.createInstance(MainThreadTerminalService));
					bridge.replaceProfiles([{
						runtimeId: 'background-runtime', packageDigest: digest, profileId: 'background', title: 'Background',
						invoke: async () => ({ options: { name: 'Background', shellPath: '/extension/shell' } }),
					}]);
				}
				window.ashTerminalEditorIntegration = {
					activeContext: () => services.get(IContextKeyService).getValue<boolean>(TerminalHasActiveInstanceContext.key) === true,
					copyToSide: async (sticky: boolean) => {
						const input = editors.activeEditor!;
						if (sticky) editors.activeGroup.stickEditor(input);
						await editors.openEditor(input, { pinned: true }, 'sideGroup');
					},
					confirmClose: () => services.get(IConfigurationService).updateValue('terminal.integrated.confirmOnKill', 'editor'),
					createBackground: async (contributed = false) => {
						const instance = await terminals.createTerminal({ ...(contributed ? { config: services.get(ITerminalProfileService).contributedProfiles[0]! } : { profile: { type: 'default' as const } }), location: { preserveFocus: true } });
						return instance.id;
					},
					split: () => part.splitActiveGroupHorizontal(),
					stick: () => editors.activeGroup.stickEditor(editors.activeEditor!),
					closeAll: (excludeSticky = false) => part.closeAllEditors({ excludeSticky }),
					closeGroup: (id: number) => part.removeGroup(id),
					confirmOnKill: () => services.get(IConfigurationService).updateValue('terminal.integrated.confirmOnKill', 'always'),
					closedProcesses: () => closedProcesses,
					revealBackground: async (id: string) => {
						const instance = terminals.instances.find(instance => instance.id === id);
						if (!instance) throw new Error('Background terminal is unavailable');
						await services.get(ITerminalEditorService).openEditor(instance, { preserveFocus: true });
					},
					groups: () => editors.groups.map(group => ({ id: group.id, resources: group.inputs.map(input => input.resource.toString()) })),
					state: () => ({ instances: terminals.instances.length, created: nextTerminal, editorTabs: editors.groups.flatMap(group => group.inputs).length, originalScreen: terminal.xterm === screen, target: terminal.target }),
					disconnect: () => connectionChanged.fire('stopped'),
					close: async () => { const input = editors.activeEditor; if (input) await editors.activeGroup.closeEditor(input); },
					restore: async () => {
						const { EditorInputSerializers } = await import('../../../src/ash/workbench/services/editor/common/editorInputSerializer.js');
						const input = editors.activeEditor!;
						const saved = EditorInputSerializers.serialize(input);
						await editors.activeGroup.closeEditor(input);
						await terminal.close();
						await editors.openEditor(EditorInputSerializers.deserialize(saved), { pinned: true });
					},
				};
			}
			const [{ ITerminalEditingService }, { TerminalEditingService }] = await Promise.all([
				import('../../../src/ash/workbench/contrib/terminal/browser/terminal.js'),
				import('../../../src/ash/workbench/contrib/terminal/browser/terminalEditingService.js'),
			]);
			services.registerSingleton(ITerminalEditingService, () => services.createInstance(TerminalEditingService));
			window.ashTerminalGroupsIntegration = {
				command: (id, args) => commands.executeCommand(id, args),
				metadata: () => ({ title: terminals.activeInstance?.title, icon: terminals.activeInstance?.profile.icon?.id, created: nextTerminal }),
				groups: () => services.get(ITerminalGroupService).groups.map(group => group.terminalInstances.map(instance => instance.id)),
				launchDirectories: () => launchDirectories,
				active: () => terminals.activeInstance?.id,
				writes: () => routedWrites,
				clearWrites: () => { routedWrites.length = 0; },
				sizes: () => sizes,
				feed: text => writeP(screen.raw, text),
				close: () => terminals.closeTerminal(terminals.activeInstance!),
				dispose: () => groupPane?.dispose(),
			};
		}
		if (sequenceFixture) {
			window.ashTerminalSequenceIntegration = {
				command: args => commands.executeCommand('workbench.action.terminal.sendSequence', args),
				errors: () => notifications.model.getNotifications().map(item => item.message),
				help: async () => {
					const { TerminalAccessibilityHelpProvider } = await import('../../../src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibilityHelp.js');
					using provider = new TerminalAccessibilityHelpProvider(terminal, services.get(IConfigurationService).getValue<boolean>('terminal.integrated.suggest.enabled'));
					return provider.provideContent();
				},
			};
		}
		if (clipboardFixture) {
			window.ashTerminalClipboardIntegration = {
				command: id => commands.executeCommand(id),
				title: id => {
					const title = CommandsRegistry.getCommands().get(id)?.metadata?.description;
					return typeof title === 'string' ? title : title?.value;
				},
				copied,
				setText: text => { clipboardText = text; },
				reads: () => clipboardReads,
				warningPolicy: async () => {
					const configuration = services.get(IConfigurationService) as WorkbenchConfigurationService;
					await configuration.reloadConfiguration();
					const key = 'terminal.integrated.enableMultiLinePasteWarning';
					return { value: configuration.getValue<string>(key), persisted: JSON.parse((await configuration.read()).source)[key] ?? null };
				},
				select: (start, length) => screen.raw.select(start, 0, length),
				activateOriginal: () => terminals.setActiveInstance(terminal),
				activateOther: () => terminals.setActiveInstance(terminals.instances.find(instance => instance !== terminal)),
				selection: () => screen.raw.getSelection(),
				selectedContext: () => services.get(IContextKeyService).getContext(document.activeElement).getValue<boolean>('terminalTextSelectedInFocused') === true,
				hold: () => { holdRead = true; },
				beginPaste: () => {
					pasteFinished = false;
					pasteOperation = commands.executeCommand('workbench.action.terminal.paste').finally(() => { pasteFinished = true; });
					void pasteOperation.catch(() => { });
				},
				finished: () => pasteFinished,
				holdInput: () => { holdInput = true; },
				releaseInput: failed => { releaseInput!(failed); releaseInput = undefined; },
				release: text => { releaseRead!(text); releaseRead = undefined; },
				reject: () => { rejectRead!(); rejectRead = undefined; },
				finish: async () => { try { await pasteOperation; return undefined; } catch (error) { return (error as Error).message; } },
				disconnect: () => { connectionChanged.fire('crashed'); return terminal.state; },
				switchAway: async () => {
					screen.setVisible(false);
					const other = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
					(await other.xtermReadyPromise)!.focus();
				},
				switchBack: () => { terminals.activeInstance!.xterm!.setVisible(false); terminals.setActiveInstance(terminal); screen.setVisible(true); screen.focus(); },
				help: async () => {
					const { AccessibleViewRegistry } = await import('../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js');
					const provider = AccessibleViewRegistry.getImplementations().find(item => item.name === 'terminal' && item.type === 'help')!.getProvider(services)!;
					const content = provider.provideContent(); provider.dispose(); return content;
				},
			};
		}
		window.ashTerminalFindIntegration = {
			command: id => commands.executeCommand(id),
			context: () => {
				const context = services.get(IContextKeyService).getContext(document.activeElement);
				return { terminal: context.getValue<boolean>('terminalFocus') === true, find: context.getValue<boolean>('terminalFindFocused') === true };
			},
			result: () => ({ result: screen.findResult, selection: screen.raw.getSelection(), position: screen.raw.getSelectionPosition() }),
			help: async () => {
				const { AccessibleViewRegistry } = await import('../../../src/ash/platform/accessibility/browser/accessibleViewRegistry.js');
				const provider = AccessibleViewRegistry.getImplementations().find(item => item.name === 'terminal-find')!.getProvider(services)!;
				const content = provider.provideContent();
				provider.dispose();
				return content;
			},
			theme: setTerminalTestTheme,
			errors: () => notifications.model.getNotifications().map(item => item.message),
		};
	}
	window.ashTerminalInputIntegration = {
		writes,
		path: (resource, execute) => terminal.sendPath(URI.parse(resource), execute),
		cwd: () => terminal.cwd,
		viewport: () => ({ top: screen.raw.buffer.active.viewportY, bottom: screen.raw.buffer.active.baseY, rows: screen.raw.rows, type: screen.raw.buffer.active.type }),
		alternateContext: () => services.get(IContextKeyService).getContext(screen.raw.textarea!).getValue<boolean>('terminalAltBufferActive'),
		visit: path => { currentDirectory = path; },
		command: id => services.get(ICommandService).executeCommand(id),
		configure: (key, value) => services.get(IConfigurationService).updateValue(key, value),
		dimensions: () => ({ cols: screen.raw.cols, rows: screen.raw.rows }),
		clear: () => { writes.length = 0; },
		send: (text, execute, paste) => terminal.sendText(text, execute, paste),
		pasteMode: () => screen.raw.modes.bracketedPasteMode,
		feed: (text, shellIntegration) => { queuedOutput.push({ data: new TextEncoder().encode(text), shellIntegration }); },
		screenReader: enabled => services.get(IAccessibilityService).setAccessibilitySupport(enabled ? AccessibilitySupport.Enabled : AccessibilitySupport.Disabled),
		accessible: async () => {
			const { TerminalAccessibleBufferProvider } = await import('../../../src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibleBufferProvider.js');
			using provider = new TerminalAccessibleBufferProvider(terminal, screen);
			const content = provider.provideContent();
			return { content, lines: content.split('\n') };
		},
		reattach: () => { terminal.detachFromElement(); terminal.attachToElement(document.querySelector<HTMLElement>('#terminal')!); screen.setVisible(true); screen.focus(); return terminal.xterm === screen; },
		snapshot: () => screen.getBufferText(100_000, new AbortController().signal),
		hasScreen: () => terminal.xterm !== undefined,
		close: () => terminal.close(),
	};
	if (new URLSearchParams(location.search).has('osc99')) {
		const { IStatusbarService, StatusbarAlignment } = await import('../../../src/ash/workbench/services/statusbar/browser/statusbar.js');
		const { StatusbarService } = await import('../../../src/ash/workbench/browser/parts/statusbar/statusbarPart.js');
		const [{ NotificationsToasts }, { NotificationActionRunner }] = await Promise.all([
			import('../../../src/ash/workbench/browser/parts/notifications/notificationsToasts.js'),
			import('../../../src/ash/workbench/browser/parts/notifications/notificationsCommands.js'),
		]);
		const statusbar = store.add(new StatusbarService());
		services.registerInstance(IStatusbarService, statusbar);
		const actionRunner = store.add(services.createInstance(NotificationActionRunner));
		store.add(services.createInstance(NotificationsToasts, document.body, notifications.model, actionRunner));
		window.ashTerminalOscIntegration = {
			notifications: () => notifications.model.getNotifications().map(item => ({ id: item.id, message: item.message, labels: item.actions?.primary?.map(action => action.label) ?? [] })),
			snapshotActive: async () => terminals.activeInstance?.xterm?.getBufferText(100000, new AbortController().signal),
			feedActive: text => {
				const id = [...processPids].find(([, pid]) => pid === terminals.activeInstance!.processId)?.[0];
				if (!id) throw new Error('No process owns the active terminal');
				const queue = directedOutput.get(id) ?? [];
				directedOutput.set(id, queue);
				queue.push({ data: new TextEncoder().encode(text) });
			},
			stopRecording: () => statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.(),
			recording: () => statusbar.getEntries(StatusbarAlignment.Left).length > 0,
		};
	}
}

declare global {
	interface Window {
		ashTerminalOscIntegration: {
			notifications(): { id: number; message: string; labels: readonly string[]; }[];
			snapshotActive(): Promise<string | undefined>;
			feedActive(text: string): void;
			stopRecording(): unknown;
			recording(): boolean;
		};
		ashTerminalSuggestIntegration: {
			holdActivation(): void;
			activationCancelled(): boolean | undefined;
			releaseActivation(): void;
			configure(key: string, value: unknown): Promise<void>;
			provider(items: readonly import('../../../src/ash/workbench/contrib/terminalContrib/suggest/browser/terminalCompletionService.js').ITerminalCompletion[], triggers?: string[], delayed?: boolean): void;
			providerRequests(): { value: string; cursorIndex: number; cancelled: boolean; }[];
			releaseProvider(): void;
			disposeProvider(): void;
			history(command: string, trusted?: boolean, disabled?: boolean): void;
			file(path: string): Promise<void>;
			directory(path: string): Promise<void>;
			holdFiles(): void;
			filesPending(): boolean;
			releaseFiles(): void;
			model(): string | undefined;
		};
		ashTerminalClipboardIntegration: {
			command(id: string): Promise<unknown>;
			title(id: string): string | undefined;
			readonly copied: readonly string[];
			setText(text: string): void;
			reads(): number;
			warningPolicy(): Promise<{ value: string; persisted: string | null; }>;
			select(start: number, length: number): void;
			activateOriginal(): void;
			activateOther(): void;
			selection(): string;
			selectedContext(): boolean;
			hold(): void;
			beginPaste(): void;
			finished(): boolean;
			holdInput(): void;
			releaseInput(failed: boolean): void;
			release(text: string): void;
			reject(): void;
			finish(): Promise<string | undefined>;
			disconnect(): string;
			switchAway(): Promise<void>;
			switchBack(): void;
			help(): Promise<string>;
		};
		ashTerminalFindIntegration: {
			command(id: string): Promise<unknown>;
			context(): { terminal: boolean; find: boolean; };
			result(): { result: import('@xterm/addon-search').ISearchResultChangeEvent | undefined; selection: string; position: import('@xterm/xterm').IBufferRange | undefined; };
			help(): Promise<string>;
			theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight', overrides?: Readonly<Record<string, string>>): void;
			errors(): readonly string[];
		};
		ashTerminalEditorIntegration: {
			activeContext(): boolean;
			copyToSide(sticky: boolean): Promise<void>;
			confirmClose(): Promise<void>;
			createBackground(contributed?: boolean): Promise<string>;
			split(): Promise<void>;
			stick(): void;
			closeAll(excludeSticky?: boolean): Promise<boolean>;
			closeGroup(id: number): Promise<boolean>;
			confirmOnKill(): Promise<void>;
			closedProcesses(): string[];
			revealBackground(id: string): Promise<void>;
			groups(): { id: number; resources: string[]; }[];
			disconnect(): void;
			state(): { instances: number; created: number; editorTabs: number; originalScreen: boolean; target: number | undefined; };
			close(): Promise<void>;
			restore(): Promise<void>;
		};
		ashTerminalGroupsIntegration: {
			metadata(): { title: string | undefined; icon: string | undefined; created: number; };
			command(id: string, args?: unknown): Promise<unknown>;
			groups(): readonly (readonly string[])[];
			launchDirectories(): readonly (string | undefined)[];
			active(): string | undefined;
			writes(): readonly { terminalId: string; data: string | number[]; }[];
			clearWrites(): void;
			sizes(): readonly { terminalId: string; cols: number; rows: number; }[];
			feed(text: string): void;
			close(): Promise<void>;
			dispose(): void;
		};
		ashTerminalSequenceIntegration: {
			command(args?: unknown): Promise<unknown>;
			errors(): readonly string[];
			help(): Promise<string>;
		};
		ashTerminalInputIntegration: {
			path(resource: string, execute: boolean): Promise<void>;
			cwd(): string | undefined;
			viewport(): { top: number; bottom: number; rows: number; type: 'normal' | 'alternate'; };
			alternateContext(): boolean | undefined;
			visit(path: string): void;
			command(id: string): Promise<unknown>;
			configure(key: string, value: unknown): Promise<void>;
			dimensions(): { cols: number; rows: number; };
			readonly writes: readonly (string | number[])[];
			clear(): void;
			send(text: string, execute: boolean, paste?: boolean): Promise<void>;
			pasteMode(): boolean;
			feed(text: string, event?: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent): void;
			screenReader(enabled: boolean): void;
			accessible(): Promise<{ content: string; lines: readonly string[]; }>;
			reattach(): boolean;
			snapshot(): Promise<string | undefined>;
			hasScreen(): boolean;
			close(): Promise<void>;
		};
	}
}
