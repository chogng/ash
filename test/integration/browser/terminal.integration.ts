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
import { ITerminalGroupService } from '../../../src/ash/workbench/services/terminal/browser/terminal.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { IConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/common/configurationResolver.js';
import { ConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/browser/configurationResolverService.js';
import { IPathService } from '../../../src/ash/platform/path/common/pathService.js';
import { posix } from '../../../src/ash/base/common/path.js';
import { ITerminalContributionService, ITerminalProfileResolverService, ITerminalProfileService } from '../../../src/ash/workbench/services/terminal/common/terminal.js';
import { BrowserTerminalProfileResolverService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileResolverService.js';
import { MainThreadTerminalService } from '../../../src/ash/workbench/api/browser/mainThreadTerminalService.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { TerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalConfigurationService.js';
import { TerminalProfileService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileService.js';
import { ITerminalConfigurationService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';

import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { ITerminalProcessService } from '../../../src/ash/platform/terminal/common/terminal.js';
import { OperatingSystem } from '../../../src/ash/base/common/platform.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { bindTestColorTheme } from './themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { IMenuService, MenuId } from '../../../src/ash/platform/actions/common/actions.js';
import { IContextMenuService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { AppServerAvailableContext } from '../../../src/ash/workbench/common/contextkeys.js';
import { WorkbenchKeybindingService } from '../../../src/ash/workbench/services/keybinding/browser/keybindingService.js';
import { BrowserKeyboardLayoutService } from '../../../src/ash/workbench/services/keybinding/browser/keyboardLayoutService.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { CommandRegistry, CommandsRegistry, ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { KeybindingRegistry } from '../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IUserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../src/ash/workbench/services/userDataProfile/browser/userDataProfileService.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import '../../../src/ash/workbench/contrib/commands/common/commands.contribution.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import '../../../src/ash/workbench/contrib/terminalContrib/voice/browser/terminal.voice.contribution.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ITerminalService, type ITerminalDimensions, type ITerminalInstance } from '../../../src/ash/workbench/services/terminal/browser/terminal.js';
import { GeneralShellType, ITerminalLogService, PosixShellType } from '../../../src/ash/platform/terminal/common/terminal.js';
import { IVoiceCodeTranscriptionBackendService } from '../../../src/ash/platform/renderer/common/dictation.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { ISpeechService } from '../../../src/ash/workbench/contrib/speech/common/speechService.js';
import { SpeechService } from '../../../src/ash/workbench/contrib/speech/browser/speechService.js';
import { registerTestDictationOnboarding, createTestDictationBackend, installTestDictationAudio } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { extUri } from '../../../src/ash/base/common/resources.js';
import { BrowserLayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { createCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { XtermTerminal } from '../../../src/ash/workbench/contrib/terminal/browser/xterm/xtermTerminal.js';
import { TerminalCapability } from '../../../src/ash/platform/terminal/common/capabilities/capabilities.js';

import { IClipboardService } from '../../../src/ash/platform/clipboard/common/clipboardService.js';
import { BrowserClipboardService } from '../../../src/ash/platform/clipboard/browser/clipboardService.js';
import { TerminalHasActiveInstanceContext } from '../../../src/ash/workbench/contrib/terminal/common/terminalContextKey.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const store = new DisposableStore();
store.add(installTestDictationAudio(window));
setIconResolver(document, icon => getIconDefinition(icon));
function setupTerminalFixtureServices(services: import('../../../src/ash/platform/instantiation/common/instantiationService.js').InstantiationService, lifetime: DisposableStore): void {
	if (!services.has(ITerminalGroupService)) services.registerSingleton(ITerminalGroupService, () => lifetime.add(services.createInstance(TerminalGroupService)));
	if (!services.has(IStorageService)) services.registerInstance(IStorageService, lifetime.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'terminal-integration', flushInterval: 0 })));
	if (!services.has(IEnvironmentVariableService)) services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
	if (!services.has(IHoverService)) services.registerInstance(IHoverService, lifetime.add(new HoverService(services.get(IConfigurationService), lifetime.add(new BrowserContextViewService(document.body)), { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } })));
	services.registerInstance(ITerminalContributionService, { terminalProfiles: [], onDidChangeTerminalProfiles: Event.None, ...Disposable.None });
	services.registerInstance(IExtensionService, { getExtensionPointContributions: () => [], currentCatalog: { generation: 0, extensions: [], diagnostics: [] }, onDidChange: Event.None, activateByEvent: async () => { } } as unknown as IExtensionService);
	services.registerInstance(IPathService, { path: Promise.resolve(posix), resolvedUserHome: URI.file('/home/test'), userHome: async () => URI.file('/home/test'), getPath: async () => posix, getOperatingSystem: async () => OperatingSystem.Linux, fileURI: async (path: string) => URI.file(path) } as unknown as IPathService);
	services.registerInstance(IConfigurationResolverService, lifetime.add(services.createInstance(ConfigurationResolverService)));
}

const writes: string[] = [];
const binaryWrites: number[][] = [];
const resizes: ITerminalDimensions[] = [];
let nextFixtureInstance = 0;
function createFixtureInstance(id: string) {
	let screen: XtermTerminal | undefined;
	let ready: Promise<XtermTerminal | undefined> | undefined;
	const fixture = {
		...Disposable.None,
		id,
		instanceId: ++nextFixtureInstance,
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
		sendSignal: async () => { }, sendText: async (data, shouldExecute) => { writes.push(data + (shouldExecute ? '\r' : '')); },
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
widgetServices.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
const themeService = store.add(new TestThemeService(darkColorTheme));
if (new URLSearchParams(location.search).has('find') || new URLSearchParams(location.search).has('browser')) { store.add(bindTestColorTheme(themeService, document.body)); }
widgetServices.registerInstance(IThemeService, themeService);
widgetServices.registerInstance(ITerminalLogService, new NullLoggerService());
widgetServices.registerInstance(ITerminalConfigurationService, store.add(widgetServices.createInstance(TerminalConfigurationService)));
widgetServices.registerInstance(IHoverService, store.add(new HoverService(widgetServices.get(IConfigurationService), store.add(new BrowserContextViewService(document.body)), { contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, showContextMenu: () => { }, hideContextMenu: () => { } })));
instance.attachToElement(document.querySelector<HTMLElement>('#terminal')!);
const widget = instance.xterm!;
widget.setVisible(true);
if (new URLSearchParams(location.search).has('browser')) widget.element.style.height = '100%';
let completion: Promise<void> | undefined;

window.ashTerminalIntegration = {
	configure: async (key, value) => { await widgetServices.get(IConfigurationService).updateValue(key, value); },
	options: () => ({ fontSize: widget.raw.options.fontSize, fontFamily: widget.raw.options.fontFamily, cursorStyle: widget.raw.options.cursorStyle, cursorBlink: widget.raw.options.cursorBlink, scrollback: widget.raw.options.scrollback, lineHeight: widget.raw.options.lineHeight, letterSpacing: widget.raw.options.letterSpacing, minimumContrastRatio: widget.raw.options.minimumContrastRatio }),
	theme: mode => {
		themeService.setColorTheme({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[mode]);
		return { background: widget.raw.options.theme?.background, foreground: widget.raw.options.theme?.foreground, red: widget.raw.options.theme?.red };
	},
	snapshot: limit => widget.getBufferText(limit, new AbortController().signal),
	writes,
	binaryWrites,
	resizes,
	fit: () => widget.fit(),
	write: text => widget.write(text),
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
		ashTerminalIntegration: {
			configure(key: string, value: unknown): Promise<void>;
			options(): { fontSize?: number; fontFamily?: string; cursorStyle?: string; cursorBlink?: boolean; scrollback?: number; lineHeight?: number; letterSpacing?: number; minimumContrastRatio?: number; };
			theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight'): { background: string | undefined; foreground: string | undefined; red: string | undefined; };
			snapshot(limit: number): Promise<string | undefined>;
			readonly writes: readonly string[];
			readonly binaryWrites: readonly number[][];
			readonly resizes: readonly ITerminalDimensions[];
			fit(): void;
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
	const notifications = store.add(new NotificationService());
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
	window.ashTerminalBatchIntegration = { order, errors: () => notifications.getNotifications().map(item => item.message) };
}

declare global {
	interface Window {
		ashTerminalBatchIntegration: { readonly order: readonly unknown[]; errors(): readonly string[]; };
	}
}

// Exercise the production pane with controlled process and workspace boundaries.
if (new URLSearchParams(location.search).has('pane') || new URLSearchParams(location.search).has('windows')) {
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
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
		let profiles = 0;
		let creates = 0;
		const createdProfiles: string[] = [];
		const launches: { profile: unknown; env: unknown; cwd: unknown; }[] = [];
		const availableProfiles = new URLSearchParams(location.search).has('profiles') ? [instance.profile, { profileId: 'bash', title: 'Bash', isDefault: false }] : [instance.profile];
		let release: (() => void) | undefined;
		let pending: Promise<void> = Promise.resolve();
		const instances: ITerminalInstance[] = new URLSearchParams(location.search).has('existing') ? [instance] : [];
		let activeInstance = instances.at(-1);
		const workspace = { id: 'workspace', folders: [{ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }] };
		const setPanel = (value: boolean): void => {
			visible = value;
			visibility.fire({ partId: 'panel', visible });
			pane.setVisible(visible && selected);
		};
		const terminals: ITerminalService = {
			...Disposable.None,
			instances,
			get activeInstance() { return activeInstance; },
			onDidCreateInstance: created.event,
			onDidDisposeInstance: disposed.event,
			onDidChangeInstances: instancesChanged.event,
			onDidChangeActiveInstance: activeChanged.event,
			getProfiles: async () => { profiles++; await pending; return availableProfiles; },
			createTerminal: async options => {
				creates++;
				const profileId = options.profile?.type === 'profile' ? options.profile.profileId : undefined;
				const selected = options.profile?.type === 'custom' ? { profileId: `custom:${options.profile.name}`, title: options.profile.name, isDefault: false }
					: availableProfiles.find(profile => profile.profileId === profileId) ?? instance.profile;
				createdProfiles.push(selected.profileId);
				launches.push({ profile: options.profile, env: options.env, cwd: options.cwd });
				const createdInstance = instances.length === 0 ? instance : createFixtureInstance(`test-terminal-${creates}`);
				Object.assign(createdInstance, { profile: { ...selected, icon: options.icon, color: options.color }, title: selected.title });
				instances.push(createdInstance);
				activeInstance = createdInstance;
				const clear = createdInstance.clearBuffer.bind(createdInstance);
				createdInstance.clearBuffer = () => { cleared.push(createdInstance.instanceId); clear(); };
				created.fire(createdInstance);
				instancesChanged.fire();
				return createdInstance;
			},
			relaunchTerminal: async instance => { relaunched.push(instance.instanceId); await pending; },
			setActiveInstance: instance => { activeInstance = instance; activeChanged.fire(instance); },
			moveTerminal: (instance, index) => { const current = instances.indexOf(instance); instances.splice(current, 1); instances.splice(index, 0, instance); instancesChanged.fire(); },
			closeTerminal: async instance => {
				closed.push(instance.instanceId); instances.splice(instances.indexOf(instance), 1);
				if (activeInstance === instance) activeInstance = instances.at(-1);
				disposed.fire(instance); activeChanged.fire(activeInstance); instancesChanged.fire();
			},
		};
		services.registerInstance(ITerminalService, terminals);
		let transcript!: (text: string, isFinal: boolean) => void;
		let stops = 0;
		services.registerInstance(IVoiceCodeTranscriptionBackendService, createTestDictationBackend(store, { getOptions: async () => ({ inputDevices: [], languages: [] }), start: async (_options, callback) => { transcript = callback; return { stop: async () => { stops++; }, cancel: async () => { stops++; } }; } }));
		services.registerInstance(IContextKeyService, context);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerInstance(IViewsService, { openView: () => pane, getViewWithId: () => pane, focusView: () => { pane.focus(); return true; } } as unknown as IViewsService);
		services.registerInstance(IPreferencesService, { openSettings: async () => { } } as unknown as IPreferencesService);
		services.registerInstance(INotificationService, lifetime.add(new NotificationService()));
		services.registerInstance(IWorkspaceContextService, { onDidChangeWorkspace: workspaceChanged.event, getWorkspace: () => workspace, getWorkbenchState: () => 2, getWorkspaceFolder: resource => workspace.folders.find(folder => extUri.isEqualOrParent(resource, folder.uri)) ?? null });
		services.registerInstance(IConfigurationService, lifetime.add(new WorkbenchConfigurationService({ source: '{"dictation.backend":"cloud"}' })));
		services.registerInstance(ITerminalProcessService, {
			operatingSystem: new URLSearchParams(location.search).get('os') === 'windows' ? OperatingSystem.Windows : OperatingSystem.Linux, onConnectionState: Event.None,
			getEnvironment: async () => ({ HOME: '/home/test', PROFILE_ARG: 'literal;$HOME' }),
			sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }),
		} as unknown as ITerminalProcessService);
		setupTerminalFixtureServices(services, lifetime);
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
		const pane = lifetime.add(new TerminalViewPane(root, { id: 'terminal', title: 'Terminal' }, terminals, Object.assign(lifetime.add(new BrowserLayoutService({ root })), {
			onDidChangePartVisibility: visibility.event,
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
		}), {
			onDidChangeWorkspace: workspaceChanged.event,
			getWorkspace: () => workspace,
			getWorkbenchState: () => 2,
			getWorkspaceFolder: resource => workspace.folders.find(folder => extUri.isEqualOrParent(resource, folder.uri)) ?? null,
		}, services, profileService, resolver, services.get(ITerminalProcessService), services.get(ITerminalGroupService)));
		root.append(pane.partTitleProjection.actions!);
		pane.layout(Math.max(0, root.clientHeight - pane.partTitleProjection.actions!.offsetHeight), 0, root.clientWidth);
		return {
			configure: (key, value) => services.get(IConfigurationService).updateValue(key, value),
			environment: enabled => enabled ? services.get(IEnvironmentVariableService).set('acme.environment', { persistent: false, map: new Map([['MODE', { variable: 'MODE', type: 1, value: 'extension' }]]) }) : services.get(IEnvironmentVariableService).delete('acme.environment'),
			createdProfiles: () => [...createdProfiles],
			launches: () => [...launches],
			defaultProfile: () => profileService.getDefaultProfile()?.profileId,
			operations: () => ({ cleared, closed, relaunched }),
			menuActions: () => menu.getMenuActions(MenuId.TerminalInstanceContext).flatMap(([, actions]) => actions.map(action => action.label)),
			ids: () => instances.map(instance => instance.instanceId),
			activate: id => terminals.setActiveInstance(instances.find(instance => instance.instanceId === id)),
			activeId: () => terminals.activeInstance?.instanceId,
			snapshot: () => pane.getTerminalOutput(instance, 100_000, new AbortController().signal),
			counts: () => ({ profiles, creates }),
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
			environment(enabled: boolean): void;
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
	const [{ InstantiationService }, { ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { WorkspaceContextService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/instantiationService.js'),
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
	]);
	window.ashTerminalAssemblyIntegration = async () => {
		using resources = new DisposableStore();
		const workspace = resources.add(new WorkspaceContextService({ id: 'assembly', uri: URI.file('/workspace') }));
		const calls: string[] = [];
		const written = new Set<string>();
		let nextProcess = 1;
		const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
			getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/backend/workspace' }, cwd: '/backend/current', rows: 24, cols: 80 }),
			getConnectionState: async () => 'ready',
			onConnectionState: () => Disposable.None,
			sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [instance.profile],
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
			container.registerInstance(ICommandService, widgetServices.get(ICommandService));
			setupTerminalFixtureServices(container, resources);
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
		const missing = resources.add(new InstantiationService(new ServiceCollection([IWorkspaceContextService, workspace])));
		try { installWorkbenchServiceContributions({ container: missing, register: value => resources.add(value), blockRestorationUntil: () => { } }); }
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
	const [{ IEmbedderTerminalService }, { TerminalMainContribution }, { getSingletonServiceDescriptors }, { ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { WorkspaceContextService }, { installWorkbenchServiceContributions }, { WorkbenchContributionsRegistry, WorkbenchPhase }] = await Promise.all([
		import('../../../src/ash/workbench/services/terminal/common/embedderTerminalService.js'),
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalMainContribution.js'),
		import('../../../src/ash/platform/instantiation/common/extensions.js'),
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
		import('../../../src/ash/workbench/common/contributions.js'),
	]);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IEmbedderTerminalService)![1];
	const workspace = store.add(new WorkspaceContextService({ id: 'host-output' }));
	const backendCalls: string[] = [];
	const rejectBackend = async (): Promise<never> => { backendCalls.push('unexpected'); throw new Error('Host output has no backend'); };
	const services = store.add(widgetServices.createChild(new ServiceCollection(
		[IEmbedderTerminalService, descriptor],
		[IWorkspaceContextService, workspace],
		[ITerminalProcessService, { getEnvironment: async () => ({}), listProfiles: rejectBackend, create: rejectBackend, write: rejectBackend, resize: rejectBackend, read: rejectBackend, getProcessInfo: rejectBackend, close: rejectBackend, getConnectionState: async () => 'crashed', onConnectionState: Event.None }],
	)));
	setupTerminalFixtureServices(services, store);
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	let hostWidget: import('../../../src/ash/workbench/services/terminal/browser/terminal.js').IXtermTerminal;
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
	window.ashEmbedderTerminalIntegration = {
		ready: async () => { await hostReady; },
		name: value => hostName.fire(value),
		output: value => hostOutput.fire(value),
		exit: code => hostExit.fire(code),
		status: () => ({ opens, closes, backendCalls, title: terminals.activeInstance?.title, state: terminals.activeInstance?.state, readOnly: terminals.activeInstance?.isReadOnly, remaining: terminals.instances.length }),
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
	const [{ ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { WorkspaceContextService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js'),
		import('../../../src/ash/workbench/browser/workbenchServiceContributions.js'),
	]);
	const reads: number[] = [];
	const events: string[] = [];
	let closes = 0;
	const bytes = new TextEncoder().encode('中文🙂\r\n');
	const reportCwd = new URLSearchParams(location.search).has('cwd');
	const reportHistory = new URLSearchParams(location.search).has('history');
	const reuseCommands = new URLSearchParams(location.search).has('reuseCommands');
	const commandModel = new URLSearchParams(location.search).has('commandModel');
	let modelSequence = 0;
	const modelOutput: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessOutputChunk[] = [];
	const queueModel = (data: string, shellIntegration?: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent) => {
		modelOutput.push({ sequence: ++modelSequence, data: new TextEncoder().encode(data), ...(shellIntegration ? { shellIntegration } : {}) });
	};
	if (commandModel) {
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
		getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/workspace' }, cwd: '/workspace/current', rows: 24, cols: 80 }),
		sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [profile],
		create: async () => { launch++; return { terminalId: reuseCommands ? `stream-shell-${launch}` : 'stream-shell', ready: { pid: reuseCommands ? 1234 + launch : 1234, cwd: '/workspace' }, profile, connectionPersistence: 'connectionOwned' }; },
		write: async options => { if (commandModel && typeof options.data === 'string') queueModel(options.data); },
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
					return { sequence: index + 1, data: new TextEncoder().encode(`line-${index}\r\n`) };
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
	const workspace = store.add(new WorkspaceContextService({ id: 'stream', uri: URI.file('/workspace') }));
	const services = store.add(widgetServices.createChild(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	setupTerminalFixtureServices(services, store);
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	let screen: import('../../../src/ash/workbench/services/terminal/browser/terminal.js').IXtermTerminal | undefined;
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
	const terminal = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	window.ashTerminalStreamIntegration = {
		status: () => ({ reads, events, closes, state: terminal.state, remaining: terminals.instances.length, ...(reportCwd ? { cwd: terminal.cwd } : {}), ...(reportHistory ? { shellIntegration: terminal.shellIntegration } : {}) }),
		reuse: async () => { await terminal.reuseTerminal({ executable: '/bin/sh', args: [], deferStart: true }); terminal.start(); },
		start: async () => {
			if (!screen) { terminal.attachToElement(document.querySelector<HTMLElement>('#terminal')!); screen = terminal.xterm!; screen.setVisible(true); }
			await terminal.xtermReadyPromise; screen.focus();
		},
		feedModel: text => queueModel(text),
		environmentFrame: event => queueModel('', event),
		environment: () => terminal.capabilities?.get(TerminalCapability.ShellEnvDetection)?.env,
		serializeModel: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.serialize(),
		commandStartContents: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.commands.map(command => command.commandStartLineContent),
		restoreModel: value => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.deserialize(value),
		clearModel: () => terminal.capabilities!.get(TerminalCapability.CommandDetection)!.clearCommands(),
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
			status(): { reads: number[]; events: string[]; closes: number; state: string; remaining: number; cwd?: string; shellIntegration?: import('../../../src/ash/workbench/services/terminal/browser/terminal.js').ITerminalShellIntegration; };
			feedModel(text: string): void;
			environmentFrame(event: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalShellIntegrationEvent): void;
			environment(): import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').TerminalShellIntegrationEnvironment | undefined;
			serializeModel(): import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').ISerializedCommandDetectionCapability;
			commandStartContents(): (string | undefined)[];
			restoreModel(value: import('../../../src/ash/platform/terminal/common/capabilities/capabilities.js').ISerializedCommandDetectionCapability): void;
			clearModel(): void;
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
	await import('../../../src/ash/workbench/contrib/terminal/terminal.all.js');
	const [{ ServiceCollection }, { ITerminalProcessService }, { IWorkspaceContextService }, { WorkspaceContextService }, { installWorkbenchServiceContributions }] = await Promise.all([
		import('../../../src/ash/platform/instantiation/common/serviceCollection.js'),
		import('../../../src/ash/platform/terminal/common/terminal.js'),
		import('../../../src/ash/platform/workspace/common/workspace.js'),
		import('../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js'),
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
	const launchDirectories: (string | undefined)[] = [];
	const sizes: { terminalId: string; cols: number; rows: number; }[] = [];
	const queuedOutput = [new TextEncoder().encode('retained screen\r\n\x1b[c')];
	let sequence = 0;
	const profile = { profileId: 'shell', title: 'Shell', isDefault: true };
	const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
		operatingSystem: OperatingSystem.Linux,
		getProcessInfo: async () => ({ ready: { pid: 1234, cwd: '/workspace' }, cwd: '/workspace/current', rows: 24, cols: 80 }),
		sendSignal: async () => { }, resolveProfile: async (profile: import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessProfileSelection) => ({ profile: profile.type === 'custom' ? { profileId: `custom:${profile.name}`, title: profile.name, isDefault: false } : instance.profile, executable: profile.type === 'custom' ? profile.path.at(-1)! : '/bin/sh', args: profile.type === 'custom' ? (typeof profile.args === 'string' ? profile.args : [...profile.args]) : [] }), getEnvironment: async () => ({}), listProfiles: async () => [profile],
		create: async options => {
			launchDirectories.push(options.cwd);
			return { terminalId: `input-shell-${++nextTerminal}`, ready: { pid: 1234, cwd: '/workspace' }, profile, connectionPersistence: 'connectionOwned' };
		},
		write: async options => {
			writes.push(typeof options.data === 'string' ? options.data : [...options.data]);
			routedWrites.push({ terminalId: options.terminalId, data: typeof options.data === 'string' ? options.data : [...options.data] });
			if (holdInput) {
				holdInput = false;
				await new Promise<void>((resolve, reject) => { releaseInput = failed => failed ? reject(new Error('Terminal write denied')) : resolve(); });
			}
		},
		resize: async options => { sizes.push({ terminalId: options.terminalId, cols: options.cols, rows: options.rows }); }, close: async () => { }, getConnectionState: async () => 'ready', onConnectionState: connectionChanged.event,
		read: async options => ({
			terminalId: options.terminalId, chunks: queuedOutput.splice(0).map(data => ({ sequence: ++sequence, data })), nextSequence: sequence,
			outputGap: false, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, exited: false, exitCode: undefined,
		}),
	};
	const workspace = store.add(new WorkspaceContextService({ id: 'input', uri: URI.file('/workspace') }));
	const services = store.add(widgetServices.createChild(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	setupTerminalFixtureServices(services, store);
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
		TerminalHasActiveInstanceContext.bindTo(services.get(IContextKeyService)).set(true);
		const commands = store.add(new CommandService(services));
		services.registerInstance(ICommandService, commands);
		let groupPane: import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js').TerminalViewPane | undefined;
		services.registerInstance(IViewsService, {
			openView: async () => { groupPane?.setVisible(true); groupPane?.focus(); return groupPane ?? null; },
			getViewWithId: () => groupPane ?? null,
		} as unknown as IViewsService);
		services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
		services.registerInstance(ILogService, new NullLoggerService());
		const notifications = store.add(new NotificationService());
		services.registerInstance(INotificationService, notifications);
		services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		const keybindingSource = sequenceFixture ? JSON.stringify([
			{ key: 'ctrl+alt+y', command: 'workbench.action.terminal.sendSequence', args: { text: '\u001b[1;5D${workspaceFolder}' }, when: 'terminalFocus' },
		]) : '[]';
		services.registerInstance(IFileService, { onDidChangeFiles: Event.None, readFile: async resource => ({ resource, content: keybindingSource, revision: '1' }) } as IFileService);
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
			const layout = Object.assign(store.add(new BrowserLayoutService({ root })), {
				onDidChangePartVisibility: Event.None, isPartVisible: () => true, hidePart: () => { }, hasFocus: () => false,
				setLayoutStyle: () => { }, getVisibleNeighborPart: () => undefined, isPanelMaximized: () => false,
				toggleMaximizedPanel: () => { }, getPartSize: () => ({ width: root.clientWidth, height: root.clientHeight }),
				resizePart: () => { }, showPart: () => { }, showParts: () => { }, hideParts: () => { },
			});
			services.registerInstance(IWorkbenchLayoutService, layout);
			groupPane = store.add(services.createInstance(TerminalViewPane, root, { id: 'ash.terminal', title: 'Terminal' }));
			groupPane.setVisible(true); groupPane.setExpanded(true); groupPane.layout(root.clientHeight, 0, root.clientWidth);
			if (new URLSearchParams(location.search).has('editor')) {
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
					import('../../../src/ash/workbench/services/terminal/browser/terminal.js'),
					import('../../../src/ash/workbench/contrib/terminal/browser/terminalEditorService.js'),
				]);
				services.registerSingleton(ITerminalEditorService, () => services.createInstance(TerminalEditorService));
				window.ashTerminalEditorIntegration = {
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
				import('../../../src/ash/workbench/services/terminal/browser/terminal.js'),
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
				errors: () => notifications.getNotifications().map(item => item.message),
				help: async () => {
					const { TerminalAccessibilityHelpProvider } = await import('../../../src/ash/workbench/contrib/terminalContrib/accessibility/browser/terminalAccessibilityHelp.js');
					using provider = new TerminalAccessibilityHelpProvider(terminal);
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
				select: (start, length) => screen.raw.select(start, 0, length),
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
			theme: mode => themeService.setColorTheme({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[mode]),
			errors: () => notifications.getNotifications().map(item => item.message),
		};
	}
	window.ashTerminalInputIntegration = {
		writes,
		clear: () => { writes.length = 0; },
		send: (text, execute, paste) => terminal.sendText(text, execute, paste),
		pasteMode: () => screen.raw.modes.bracketedPasteMode,
		feed: text => { queuedOutput.push(new TextEncoder().encode(text)); },
		reattach: () => { terminal.detachFromElement(); terminal.attachToElement(document.querySelector<HTMLElement>('#terminal')!); screen.setVisible(true); screen.focus(); return terminal.xterm === screen; },
		snapshot: () => screen.getBufferText(100_000, new AbortController().signal),
		hasScreen: () => terminal.xterm !== undefined,
		close: () => terminal.close(),
	};
}

declare global {
	interface Window {
		ashTerminalClipboardIntegration: {
			command(id: string): Promise<unknown>;
			title(id: string): string | undefined;
			readonly copied: readonly string[];
			setText(text: string): void;
			reads(): number;
			select(start: number, length: number): void;
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
			theme(mode: 'dark' | 'light' | 'hcDark' | 'hcLight'): void;
			errors(): readonly string[];
		};
		ashTerminalEditorIntegration: {
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
			readonly writes: readonly (string | number[])[];
			clear(): void;
			send(text: string, execute: boolean, paste?: boolean): Promise<void>;
			pasteMode(): boolean;
			feed(text: string): void;
			reattach(): boolean;
			snapshot(): Promise<string | undefined>;
			hasScreen(): boolean;
			close(): Promise<void>;
		};
	}
}
