import type { IProcessDataEvent } from '../../../src/ash/platform/terminal/common/terminal.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import '../../../src/ash/workbench/contrib/terminalContrib/voice/browser/terminal.voice.contribution.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IContextKeyService } from '../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../src/ash/platform/accessibility/browser/accessibleView.js';
import { ITerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { IDictationService } from '../../../src/ash/platform/dictation/common/dictationService.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../src/ash/workbench/contrib/chat/browser/speechToText/chatSpeechToTextService.js';
import { registerTestDictationOnboarding } from '../../../src/ash/workbench/test/common/testDictationServices.js';
import { IPreferencesService } from '../../../src/ash/workbench/services/preferences/common/preferences.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { NotificationService } from '../../../src/ash/workbench/services/notification/common/notificationService.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { extUri } from '../../../src/ash/base/common/resources.js';
import { BrowserLayoutService } from '../../../src/ash/platform/layout/browser/layoutService.js';
import { createCodeEditorServices } from '../../../src/ash/editor/test/browser/testCodeEditor.js';
import { TerminalInstanceWidget } from '../../../src/ash/workbench/contrib/terminal/browser/instance/terminalInstanceWidget.js';
import type { ITerminalDimensions, ITerminalInstance } from '../../../src/ash/workbench/contrib/terminal/browser/terminal.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { builtinLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

if (new URLSearchParams(location.search).get('locale') === 'zh-CN') {
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
}

const store = new DisposableStore();
const output = store.add(new Emitter<IProcessDataEvent>());
const exit = store.add(new Emitter<number | undefined>());
const writes: string[] = [];
const binaryWrites: number[][] = [];
const resizes: ITerminalDimensions[] = [];
const instance: ITerminalInstance = {
	...Disposable.None,
	id: 'test-terminal',
	dirId: 'workspace',
	processId: 1234,
	initialCwd: '/backend/workspace',
	title: 'Shell',
	profile: { profileId: 'shell', title: 'Shell', isDefault: true },
	state: new URLSearchParams(location.search).has('exited') ? 'exited' : 'running',
	exitCode: undefined,
	onDidWriteData: output.event,
	onDidExit: exit.event,
	onDidChangeCommandStatus: Event.None,
	onDidChangeState: Event.None,
	write: data => { writes.push(data); },
	processBinary: async data => { binaryWrites.push(Array.from(data, character => character.charCodeAt(0))); },
	resize: dimensions => { resizes.push(dimensions); },
	close: async () => { },
};
const widgetServices = createCodeEditorServices(store);
const widget = store.add(widgetServices.createInstance(TerminalInstanceWidget, document.querySelector<HTMLElement>('#terminal')!, instance));
widget.setVisible(true);
let completion: Promise<void> | undefined;

window.ashTerminalIntegration = {
	writes,
	binaryWrites,
	resizes,
	fit: () => widget.fit(),
	write: text => output.fire({ data: new TextEncoder().encode(text), trackCommit: false }),
	exit: () => exit.fire(0),
	start: () => {
		completion = widget.initialize();
		widget.focus();
		return completion === widget.initialize();
	},
	ready: async () => { await completion; },
	dispose: () => store.dispose(),
};

declare global {
	interface Window {
		ashTerminalIntegration: {
			readonly writes: readonly string[];
			readonly binaryWrites: readonly number[][];
			readonly resizes: readonly ITerminalDimensions[];
			fit(): void;
			write(text: string): void;
			exit(): void;
			start(): boolean;
			ready(): Promise<void>;
			dispose(): void;
		};
	}
}

// Exercise the production pane with controlled process and workspace boundaries.
if (new URLSearchParams(location.search).has('pane')) {
	widget.dispose();
	const [{ TerminalViewPane }, { ContextKeyService }, { MenuService }, { CommandService }, { URI }] = await Promise.all([
		import('../../../src/ash/workbench/contrib/terminal/browser/terminalView.js'),
		import('../../../src/ash/platform/contextkey/browser/contextKeyService.js'),
		import('../../../src/ash/platform/actions/common/menuService.js'),
		import('../../../src/ash/workbench/services/commands/common/commandService.js'),
		import('../../../src/ash/base/common/uri.js'),
	]);
	const visibility = store.add(new Emitter<import('../../../src/ash/workbench/services/layout/browser/layoutService.js').WorkbenchPartVisibilityChangeEvent>());
	const workspaceChanged = store.add(new Emitter<import('../../../src/ash/platform/workspace/common/workspace.js').IWorkspaceChangeEvent>());
	const created = store.add(new Emitter<ITerminalInstance>());
	const context = store.add(new ContextKeyService());
	const services = store.add(widgetServices.createChild());
	const commands = new CommandService(services);
	const menu = new MenuService(commands, context);
	let visible = false;
	let selected = true;
	let profiles = 0;
	let creates = 0;
	let release: (() => void) | undefined;
	let pending: Promise<void> = Promise.resolve();
	const instances: ITerminalInstance[] = new URLSearchParams(location.search).has('existing') ? [instance] : [];
	const workspace = { id: 'workspace', folders: [{ id: 'folder', uri: URI.file('/workspace'), name: 'Workspace', index: 0 }] };
	const setPanel = (value: boolean): void => {
		visible = value;
		visibility.fire({ partId: 'panel', visible });
		pane.setVisible(visible && selected);
	};
	const terminals: ITerminalService = {
		...Disposable.None,
		instances,
		get activeInstance() { return instances[0]; },
		onDidCreateInstance: created.event,
		onDidDisposeInstance: Event.None,
		onDidChangeInstances: Event.None,
		onDidChangeActiveInstance: Event.None,
		getProfiles: async () => { profiles++; await pending; return [instance.profile]; },
		createTerminal: async () => { creates++; instances.push(instance); created.fire(instance); return instance; },
		relaunchTerminal: async () => { await pending; },
		setActiveInstance: () => { },
		moveTerminal: () => { },
		closeTerminal: async () => { },
	};
	services.registerInstance(ITerminalService, terminals);
	let transcript!: (text: string, isFinal: boolean) => void;
	let stops = 0;
	services.registerInstance(IDictationService, { onDidChangePreparation: Event.None, getPreparation: async () => undefined, getOptions: async () => ({ inputDevices: [], languages: [] }), prepareModel: async () => { }, cancelPreparation: async () => { }, start: async (callback) => { transcript = callback; return { stop: async () => { stops++; } }; } });
	services.registerInstance(IContextKeyService, context);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(IViewsService, { openView: () => pane, getViewWithId: () => pane, focusView: () => { pane.focus(); return true; } } as unknown as IViewsService);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	registerTestDictationOnboarding(services);
	services.registerInstance(IPreferencesService, { openSettings: async () => { } } as unknown as IPreferencesService);
	services.registerInstance(INotificationService, store.add(new NotificationService()));
	const pane = store.add(new TerminalViewPane(document.querySelector<HTMLElement>('#terminal')!, { id: 'terminal', title: 'Terminal' }, terminals, menu, {
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: () => { },
		hideContextMenu: () => { },
	}, context, Object.assign(store.add(new BrowserLayoutService({ root: document.querySelector<HTMLElement>('#terminal')! })), {
		onDidChangePartVisibility: visibility.event,
		isPartVisible: () => visible,
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
	}, services));
	document.querySelector<HTMLElement>('#terminal')!.append(pane.partTitleProjection.actions!);
	window.ashTerminalPaneIntegration = {
		counts: () => ({ profiles, creates }),
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
}

declare global {
	interface Window {
		ashTerminalPaneIntegration: {
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
	await import('../../../src/ash/workbench/contrib/terminal/browser/terminal.contribution.js');
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
			getConnectionState: async () => 'ready',
			onConnectionState: () => Disposable.None,
			listProfiles: async () => [instance.profile],
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
			installWorkbenchServiceContributions({ container, register: value => resources.add(value), blockRestorationUntil: () => { } });
		};
		const services = [0, 1].map(() => {
			const container = resources.add(new InstantiationService(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
			install(container);
			return container.get(ITerminalService);
		});
		const output: string[] = [];
		const exits: Promise<number | undefined>[] = [];
		for (const service of services) {
			resources.add(service.onDidCreateInstance(terminal => {
				resources.add(terminal.onDidWriteData(data => output.push(new TextDecoder().decode(data.data))));
				exits.push(new Promise(resolve => resources.add(terminal.onDidExit(resolve))));
			}));
			const terminal = await service.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
			terminal.write('input');
			terminal.resize({ rows: 30, cols: 90 });
		}
		await Promise.all(exits);
		const isolated = services[0].instances[0] !== services[1].instances[0];
		for (const service of services) { await service.closeTerminal(service.instances[0]); }
		let missingDependency = '';
		const missing = resources.add(new InstantiationService(new ServiceCollection([IWorkspaceContextService, workspace])));
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
	await import('../../../src/ash/workbench/contrib/terminal/browser/terminal.contribution.js');
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
		[ITerminalProcessService, { listProfiles: rejectBackend, create: rejectBackend, write: rejectBackend, resize: rejectBackend, read: rejectBackend, close: rejectBackend, getConnectionState: async () => 'crashed', onConnectionState: Event.None }],
	)));
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	let hostWidget: TerminalInstanceWidget;
	let hostReady: Promise<void> = Promise.resolve();
	services.registerInstance(IViewsService, {
		openView: async (_id: string) => {
			if (!hostWidget) {
				hostWidget = store.add(services.createInstance(TerminalInstanceWidget, document.querySelector<HTMLElement>('#terminal')!, terminals.activeInstance!));
				hostWidget.setVisible(true);
				hostReady = hostWidget.initialize();
				await hostReady;
			}
			hostWidget.focus();
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
	contributions.advance(WorkbenchPhase.BlockStartup);
	window.ashEmbedderTerminalIntegration = {
		ready: async () => { await Promise.resolve(); await Promise.resolve(); await hostReady; },
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
	await import('../../../src/ash/workbench/contrib/terminal/browser/terminal.contribution.js');
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
	const profile = { profileId: 'shell', title: 'Shell', isDefault: true };
	const processes: import('../../../src/ash/platform/terminal/common/terminal.js').ITerminalProcessService = {
		listProfiles: async () => [profile],
		create: async () => ({ terminalId: 'stream-shell', ready: { pid: 1234, cwd: '/workspace' }, profile, connectionPersistence: 'connectionOwned' }),
		write: async () => { },
		resize: async () => { },
		close: async () => { closes++; },
		getConnectionState: async () => 'ready',
		onConnectionState: Event.None,
		read: async options => {
			reads.push(options.afterSequence);
			const first = options.afterSequence === 0;
			return {
				terminalId: options.terminalId,
				chunks: [{ sequence: first ? 1 : 2, data: first ? bytes.slice(0, 2) : bytes.slice(2) }],
				nextSequence: first ? 1 : 2,
				outputGap: false,
				commandEvents: first ? [{ sequence: 1, commandId: 'command', status: 'succeeded', exitCode: 0, afterOutputSequence: 2 }] : [],
				nextCommandSequence: 1,
				commandEventGap: false,
				exited: !first,
				exitCode: first ? undefined : 0,
			};
		},
	};
	const workspace = store.add(new WorkspaceContextService({ id: 'stream', uri: URI.file('/workspace') }));
	const services = store.add(widgetServices.createChild(new ServiceCollection([ITerminalProcessService, processes], [IWorkspaceContextService, workspace])));
	installWorkbenchServiceContributions({ container: services, register: value => store.add(value), blockRestorationUntil: () => { } });
	const terminals = services.get(ITerminalService);
	let screen!: TerminalInstanceWidget;
	store.add(terminals.onDidCreateInstance(instance => {
		screen = store.add(services.createInstance(TerminalInstanceWidget, document.querySelector<HTMLElement>('#terminal')!, instance));
		screen.setVisible(!new URLSearchParams(location.search).has('hidden'));
		store.add(instance.onDidChangeCommandStatus(event => events.push(event.status)));
		store.add(instance.onDidExit(() => events.push('exit')));
	}));
	const terminal = await terminals.createTerminal({ dimensions: { rows: 24, cols: 80 }, profile: { type: 'default' } });
	window.ashTerminalStreamIntegration = {
		status: () => ({ reads, events, closes, state: terminal.state, remaining: terminals.instances.length }),
		start: async () => { await screen.initialize(); screen.focus(); },
		close: async () => { await terminal.close(); store.dispose(); },
	};
}

declare global {
	interface Window {
		ashTerminalStreamIntegration: {
			status(): { reads: number[]; events: string[]; closes: number; state: string; remaining: number; };
			start(): Promise<void>;
			close(): Promise<void>;
		};
	}
}
