import { IEnvironmentVariableService } from '../../../src/ash/workbench/contrib/terminal/common/environmentVariable.js';
import { EnvironmentVariableService } from '../../../src/ash/workbench/contrib/terminal/common/environmentVariableService.js';
import { TaskService } from '../../../src/ash/workbench/contrib/tasks/browser/taskService.js';
import { TasksViewPane } from '../../../src/ash/workbench/contrib/tasks/browser/tasksViewPane.js';
import { IFileService, FileKind, FileNotFoundError } from '../../../src/ash/platform/files/common/files.js';
import { ILogService, NullLoggerService } from '../../../src/ash/platform/log/common/log.js';
import { IOutputService } from '../../../src/ash/workbench/services/output/common/output.js';
import { IMarkerService } from '../../../src/ash/platform/markers/common/markers.js';
import { MarkerService } from '../../../src/ash/platform/markers/common/markerService.js';
import { IModelService } from '../../../src/ash/editor/common/services/model.js';
import { IFileSearchService } from '../../../src/ash/platform/search/common/fileSearch.js';
import { IQuickInputService } from '../../../src/ash/platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../src/ash/platform/notification/common/notification.js';
import { ITaskService } from '../../../src/ash/workbench/services/tasks/common/taskService.js';
import { IOpenerService } from '../../../src/ash/platform/opener/common/opener.js';
import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_CLOSED_EVENT, WEB_APP_SERVER_FRAME_EVENT, WEB_APP_SERVER_PROTOCOL_VERSION, type AppServerTransport } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
import type { AppHostOperation } from '../../../.build/protocol/typescript/index.js';
import { AppToolsHost } from '../../../src/ash/sessions/contrib/appTools/browser/appToolsHost.js';
import { AppServerAppToolsHost } from '../../../src/ash/sessions/services/appTools/browser/appServerAppToolsHost.js';
import { ISessionGroupsService, SessionGroupsService } from '../../../src/ash/sessions/services/sessions/browser/sessionGroupsService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { SessionsList } from '../../../src/ash/sessions/browser/parts/sidebar/sessionsList.js';
import { BrowserStorageService } from '../../../src/ash/workbench/services/storage/browser/storageService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { Emitter, Event } from '../../../src/ash/base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { ITerminalService } from '../../../src/ash/workbench/services/terminal/browser/terminal.js';
import { TerminalService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalService.js';
import { ITerminalContributionService, ITerminalProfileResolverService, ITerminalProfileService } from '../../../src/ash/workbench/services/terminal/common/terminal.js';
import { TerminalProfileService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileService.js';
import { BrowserTerminalProfileResolverService } from '../../../src/ash/workbench/contrib/terminal/browser/terminalProfileResolverService.js';
import { ITerminalProcessService, type ITerminalProcessCreateOptions, type TerminalProcessProfileSelection } from '../../../src/ash/platform/terminal/common/terminal.js';
import { OperatingSystem } from '../../../src/ash/base/common/platform.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { IWorkspaceContextService } from '../../../src/ash/platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../src/ash/workbench/services/workspaces/browser/workspaceContextService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { WorkbenchConfigurationService } from '../../../src/ash/workbench/services/configuration/browser/configurationService.js';
import { IConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/common/configurationResolver.js';
import { ConfigurationResolverService } from '../../../src/ash/workbench/services/configurationResolver/browser/configurationResolverService.js';
import { IPathService } from '../../../src/ash/platform/path/common/pathService.js';
import { BrowserPathService } from '../../../src/ash/workbench/services/path/browser/pathService.js';
import { ICommandService } from '../../../src/ash/platform/commands/common/commands.js';
import { CommandService } from '../../../src/ash/workbench/services/commands/common/commandService.js';
import { createDisconnectedRendererApi } from '../../../src/ash/platform/agentHost/browser/rendererApi.js';
import { IExtensionService } from '../../../src/ash/workbench/services/extensions/common/extensionService.js';
import { IViewsService } from '../../../src/ash/workbench/services/views/common/viewsService.js';
import { IChatSessionNavigationService } from '../../../src/ash/workbench/services/chat/common/chatSessionNavigationService.js';
import { IAccessibilityService } from '../../../src/ash/platform/accessibility/common/accessibility.js';
import type { ISessionsManagementService } from '../../../src/ash/sessions/services/sessions/common/sessionsManagement.js';
import type { ISessionsService } from '../../../src/ash/sessions/services/sessions/browser/sessionsService.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';
import '../../../src/ash/platform/theme/common/sizes/baseSizes.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';

if (new URL(location.href).searchParams.get('locale') === 'zh-CN') setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; }>();
	private nextId = 0;
	readonly calls: AppHostOperation[] = [];
	on(event: string, listener: (payload: unknown) => void): void { let listeners = this.listeners.get(event); if (!listeners) this.listeners.set(event, listeners = new Set()); listeners.add(listener); }
	off(event: string, listener: (payload: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, payload: unknown): void { this.listeners.get(event)?.forEach(listener => listener(payload)); }
	send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { queueMicrotask(() => this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: WEB_APP_SERVER_PROTOCOL_VERSION, workspaceId: 'app-tools', workspaceRoot: '/' })); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) return;
		const message = JSON.parse((payload as { frame: string; }).frame);
		if (message.method === 'initialize') {
			const initialization = createTestInitializeResult();
			const platform = new URL(location.href).searchParams.get('os');
			const result = { ...initialization, serverInfo: { ...initialization.serverInfo, operatingSystem: platform === 'windows' ? 'windows' : platform === 'osx' ? 'mac' : 'linux', userHome: platform === 'windows' ? 'C:\\Users\\test' : initialization.serverInfo.userHome } };
			queueMicrotask(() => this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) }));
			return;
		}
		const pending = this.pending.get(message.id);
		if (pending) { this.pending.delete(message.id); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(JSON.parse(message.result.json)); }
	}
	disconnect(): void { this.emit(WEB_APP_SERVER_CLOSED_EVENT, { message: 'Test app-server disconnect' }); }
	cancelLast(): void { this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: `host-${this.nextId}` } }) }); }
	call(operation: AppHostOperation): Promise<unknown> {
		this.calls.push(operation);
		const id = `host-${++this.nextId}`;
		return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, method: 'app/request', params: { sessionId: 'session-1', threadId: 'thread-1', turnId: 'turn-1', operation } }) }); });
	}
}
const resources = new DisposableStore();
const colorThemes = { dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const themeId = new URL(location.href).searchParams.get('theme') as keyof typeof colorThemes | null;
const colorTheme = themeId && Object.hasOwn(colorThemes, themeId) ? colorThemes[themeId] : darkColorTheme;
const theme = resources.add(new TestThemeService(colorTheme));
resources.add(bindColorTheme(theme, document.documentElement));
const transport = new Transport();
const client = new AppServerProtocolClient(transport);
resources.add(toDisposable(() => client.dispose()));
await client.connect();
const storage = resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'app-tools', flushInterval: 0 }));
const groups = resources.add(new SessionGroupsService(storage, { sessions: [], onDidChange: Event.None } as unknown as ISessionsManagementService));
const changes = resources.add(new Emitter<void>());
const opened: unknown[] = [];
const openedUrls: string[] = [];
let releaseTerminal: (() => void) | undefined;
let releaseProfile: (() => void) | undefined;
let automaticCreation = false;
let holdProfile = false;
let profileFailure = false;
let viewFailure = false;
const closedTerminals: string[] = [];
const terminalCreations: ITerminalProcessCreateOptions[] = [];
const profileSelections: TerminalProcessProfileSelection[] = [];
const terminalViews: Array<{ id: string; focus: boolean | undefined; }> = [];
const sessions = [1, 2].map(id => ({ sessionId: `session-${id}`, title: `Task ${id}`, status: 'active', chats: [{ threadId: `thread-${id}`, status: 'active', origin: { type: 'root' } }] }));
const management = { sessions, state: 'ready' } as unknown as ISessionsManagementService;
const view = { activeSelection: undefined, visibleSelections: [], onDidChange: changes.event, openNewSession: () => { }, openSession: (sessionId: string) => opened.push(sessionId) } as unknown as ISessionsService;
const container = document.createElement('main');
document.body.append(container);
resources.add(new SessionsList(container, management, view, 'Tasks', 'New task', { onDidChange: Event.None, getSessionPullRequests: () => [], getSessionIssues: () => [], attachIssue: async () => { }, detachIssue: async () => { }, initialize: () => { }, attachPullRequest: async () => { }, detachPullRequest: async () => { } }, groups));
const services = resources.add(new InstantiationService());
services.registerInstance(IStorageService, storage);
const platform = new URL(location.href).searchParams.get('os') ?? 'linux';
const workspace = resources.add(new WorkspaceContextService({ id: 'app-tools', uri: platform === 'windows' ? URI.from({ scheme: 'file', path: '/c:/workspace' }) : URI.file('/workspace') }));
const configuration = resources.add(new WorkbenchConfigurationService());
const terminalConnection = resources.add(new Emitter<import('../../../src/ash/platform/terminal/common/terminal.js').TerminalProcessConnectionState>());
let executionOS: OperatingSystem | undefined = platform === 'windows' ? OperatingSystem.Windows : platform === 'osx' ? OperatingSystem.Macintosh : OperatingSystem.Linux;
const taskProcessState = new Map<string, { exited: boolean; exitCode: number | undefined; }>();
const terminalProcesses: ITerminalProcessService = {
	get operatingSystem() { return executionOS; },
	onConnectionState: terminalConnection.event, getConnectionState: async () => 'ready',
	getEnvironment: async () => ({ HOME: '/execution/home', BASE: 'inherited' }),
	getProcessInfo: async ({ terminalId }) => {
		const index = Number(terminalId.slice('terminal-'.length)) - 1;
		const launch = terminalCreations[index];
		if (!launch) throw new Error('Terminal not found');
		const cwd = launch.cwd ?? '/workspace';
		return { ready: { pid: index + 1, cwd }, cwd, rows: launch.rows, cols: launch.cols };
	},
	listProfiles: async () => [{ profileId: 'bash', title: 'Bash', isDefault: true }],
	resolveProfile: async selection => {
		profileSelections.push(selection);
		if (holdProfile) {
			holdProfile = false;
			await new Promise<void>(resolve => { releaseProfile = resolve; });
		}
		if (profileFailure) throw new Error('Profile executable unavailable');
		return {
			profile: { profileId: selection.type === 'custom' ? `custom:${selection.name}` : 'bash', title: selection.type === 'custom' ? selection.name : 'Bash', isDefault: selection.type !== 'custom' },
			executable: selection.type === 'custom' ? selection.path[0]! : '/bin/bash', args: selection.type === 'custom' ? (typeof selection.args === 'string' ? selection.args : [...selection.args]) : [],
		};
	},
	create: async options => {
		terminalCreations.push(options);
		const terminalId = `terminal-${terminalCreations.length}`;
		if (options.execution) taskProcessState.set(terminalId, { exited: false, exitCode: undefined });
		if (!automaticCreation) await new Promise<void>(resolve => { releaseTerminal = resolve; });
		return { terminalId, ready: { pid: terminalCreations.length, cwd: options.cwd ?? '/workspace' }, profile: { profileId: options.profile.type === 'custom' ? `custom:${options.profile.name}` : 'bash', title: options.profile.type === 'custom' ? options.profile.name : 'Bash', isDefault: false }, connectionPersistence: 'connectionOwned' };
	},
	read: async options => {
		const task = taskProcessState.get(options.terminalId);
		return { terminalId: options.terminalId, chunks: task && options.afterSequence === 0 ? [{ sequence: 1, data: new TextEncoder().encode('output for ' + options.terminalId + '\n') }] : [], nextSequence: task ? 1 : 0, commandEvents: [], nextCommandSequence: 0, commandEventGap: false, outputGap: false, exited: task?.exited ?? false, exitCode: task?.exitCode };
	},
	write: async () => { throw new Error('Opening a terminal must not send command input'); },
	resize: async () => { }, close: async options => { closedTerminals.push(options.terminalId); },
};
const renderer = createDisconnectedRendererApi();
services.registerInstance(IPathService, new BrowserPathService({ ...renderer, hasAppServer: true, appServer: { ...renderer.appServer, operatingSystem: executionOS } }, workspace));
services.registerInstance(IWorkspaceContextService, workspace);
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(ITerminalProcessService, terminalProcesses);
services.registerSingleton(ICommandService, () => new CommandService(services));
services.registerSingleton(IConfigurationResolverService, () => services.createInstance(ConfigurationResolverService));
services.registerInstance(IExtensionService, { getExtensionPointContributions: () => [], onDidChange: Event.None, reload: async () => { }, activateByEvent: async () => { } } as unknown as IExtensionService);
services.registerInstance(ITerminalContributionService, { terminalProfiles: [], onDidChangeTerminalProfiles: Event.None, ...Disposable.None });
services.registerSingleton(ITerminalProfileService, () => services.createInstance(TerminalProfileService));
services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
services.registerSingleton(ITerminalProfileResolverService, () => services.createInstance(BrowserTerminalProfileResolverService));
services.registerInstance(IEditorService, { openEditor: async (...args: unknown[]) => { opened.push(args); } } as unknown as IEditorService);
services.registerInstance(IOpenerService, { open: async (resource: { toString(): string; }) => { openedUrls.push(resource.toString()); return true; } } as unknown as IOpenerService);
const terminals = resources.add(services.createInstance(TerminalService));
services.registerInstance(ITerminalService, terminals);
services.registerInstance(IViewsService, { openView: async (id: string, focus: boolean | undefined) => { if (viewFailure) throw new Error('Terminal view unavailable'); terminalViews.push({ id, focus }); } } as unknown as IViewsService);
services.registerInstance(IChatSessionNavigationService, { openConversation: async (sessionId: string, threadId: string) => { opened.push({ sessionId, threadId }); } } as unknown as IChatSessionNavigationService);
services.registerInstance(ISessionGroupsService, groups);
services.registerInstance(IAccessibilityService, { onDidChangeReducedMotion: Event.None, isMotionReduced: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches } as unknown as IAccessibilityService);
let taskSource = JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Check', command: 'compiler', presentation: { reveal: 'never' } }, { label: 'Interactive', command: '${input:value}' }] });
services.registerInstance(IFileService, {
	onDidChangeFiles: Event.None,
	stat: async (resource: URI) => { if (!resource.path.endsWith('/.vscode/tasks.json')) throw new FileNotFoundError(resource); return { kind: FileKind.File }; },
	readFile: async (resource: URI) => { if (!resource.path.endsWith('/.vscode/tasks.json')) throw new FileNotFoundError(resource); return { content: taskSource }; },
} as unknown as import('../../../src/ash/platform/files/common/files.js').IFileService);
services.registerInstance(ILogService, new NullLoggerService());
services.registerInstance(IOutputService, { createChannel: () => Object.assign(toDisposable(() => { }), { appendLine() { } }) } as unknown as import('../../../src/ash/workbench/services/output/common/output.js').IOutputService);
services.registerInstance(IMarkerService, resources.add(new MarkerService()));
services.registerInstance(IModelService, { getModel: () => null } as unknown as import('../../../src/ash/editor/common/services/model.js').IModelService);
services.registerInstance(IFileSearchService, { glob: async () => ({ matches: [] }) } as unknown as import('../../../src/ash/platform/search/common/fileSearch.js').IFileSearchService);
services.registerInstance(IQuickInputService, { createQuickPick: () => { throw new Error('No interaction expected'); } } as unknown as import('../../../src/ash/platform/quickinput/common/quickInput.js').IQuickInputService);
services.registerInstance(INotificationService, { warning() { }, error() { } } as unknown as import('../../../src/ash/platform/notification/common/notification.js').INotificationService);

const taskService = resources.add(services.createInstance(TaskService));
services.registerInstance(ITaskService, taskService);
if (new URL(location.href).searchParams.has('taskTools')) {
	const taskContainer = document.createElement('section'); document.body.append(taskContainer);
	const pane = resources.add(services.createInstance(TasksViewPane, taskContainer, { id: 'ash.tasks.integration', title: 'Tasks' }));
	pane.setVisible(true);
}
const appTools = resources.add(new AppServerAppToolsHost(client, services.createInstance(AppToolsHost, document, undefined)));
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
declare global {
	interface Window {
		ashAppToolsIntegration: {
			finishTask(code: number): void; changeTask(): void;
			configureTasks(tasks: Record<string, unknown>[]): Promise<void>; runManualTask(label: string): Promise<string>; disconnectAppServer(): void;
			readonly taskRuns: Array<{ runId: string; status: string; }>; readonly taskCancelRequests: number;
			call(operation: AppHostOperation): Promise<unknown>; readonly opened: unknown[]; readonly openedUrls: string[];
			cancelLast(): void; releaseTerminal(): void; disposeHost(): void; readonly closedTerminals: string[]; readonly terminalPending: boolean;
			configureTerminal(values: Record<string, unknown>): Promise<void>; automaticCreation(): void; holdProfile(): void; releaseProfile(): void;
			readonly profilePending: boolean; readonly terminalCreations: ITerminalProcessCreateOptions[]; readonly profileSelections: TerminalProcessProfileSelection[];
			readonly terminalViews: Array<{ id: string; focus: boolean | undefined; }>; readonly activeTerminal: string | undefined;
			changeWorkspace(): void; disconnectTerminal(): void; failProfile(): void; unavailableHost(): void; failView(): void;
		};
	}
}
window.ashAppToolsIntegration = {
	finishTask: code => { for (const task of taskProcessState.values()) { task.exited = true; task.exitCode = code; } },
	changeTask: () => { taskSource = taskSource.replace('compiler', 'changed'); },
	configureTasks: async tasks => { taskSource = JSON.stringify({ version: '2.0.0', tasks }); await taskService.refresh(); },
	runManualTask: async label => { const task = (await taskService.refresh()).find(task => task.label === label)!; return (await taskService.run(task)).runId; },
	disconnectAppServer: () => transport.disconnect(),
	get taskRuns() { return taskService.runs.map(run => ({ runId: run.runId, status: run.status })); },
	get taskCancelRequests() { return transport.calls.filter(operation => operation.type === 'tasksCancel').length; },
	call: operation => transport.call(operation), opened, openedUrls, cancelLast: () => transport.cancelLast(), releaseTerminal: () => releaseTerminal?.(),
	disposeHost: () => appTools.dispose(), closedTerminals, get terminalPending() { return releaseTerminal !== undefined; },
	configureTerminal: async values => { for (const [key, value] of Object.entries(values)) await configuration.updateValue(key, value); },
	automaticCreation: () => { automaticCreation = true; }, holdProfile: () => { holdProfile = true; }, releaseProfile: () => releaseProfile?.(),
	get profilePending() { return releaseProfile !== undefined; }, terminalCreations, profileSelections, terminalViews,
	get activeTerminal() { return terminals.activeInstance?.id; },
	changeWorkspace: () => workspace.updateWorkspace({ id: 'changed', uri: URI.file('/changed') }),
	disconnectTerminal: () => terminalConnection.fire('crashed'), failProfile: () => { profileFailure = true; }, unavailableHost: () => { executionOS = undefined; },
	failView: () => { viewFailure = true; },
};
