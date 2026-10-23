import { AgentHostConnectionsService } from '../../../../../../platform/agentHost/browser/agentHostConnectionsService.js';
import { IAgentHostConnectionsService, agentHostConnectionAddress } from '../../../../../../platform/agentHost/common/agentHostConnectionsService.js';
import { ILanguageModelsConfigurationService } from '../../../../../../workbench/contrib/chat/common/languageModelsConfiguration.js';
import type { IRendererAgentHostConnection, IRendererAgentHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import { BrowserLayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { QuickInputService } from '../../../../../../platform/quickinput/browser/quickInputService.js';
import { AgentHostFileSystemProvider } from '../../../../../../platform/agentHost/common/agentHostFileSystemProvider.js';
import { AgentHostFileSystemService, IAgentHostFileSystemService } from '../../../../../../workbench/services/agentHost/common/agentHostFileSystemService.js';
import { FileService } from '../../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService } from '../../../../../../platform/remote/common/remoteConnectionService.js';
import workbenchTranslations from '../../../../../../../../extensions/language-pack-zh-cn/translations/workbench.json' with { type: 'json' };
import type { IAction } from '../../../../../../base/common/actions.js';
import { TestNotificationService } from '../../../../../../../../test/fixtures/browser/notificationFixture.js';
import '../../../../../../base/browser/ui/styles.css';
import '../../../../../../workbench/browser/media/style.css';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { observableValue, autorun } from '../../../../../../base/common/observable.js';
import { setNlsMessages } from '../../../../../../nls.js';
import translations from '../../../../../../../../extensions/language-pack-zh-cn/translations/sessions.json' with { type: 'json' };
import type { Automation, AutomationDefinition, AutomationRun, IAutomationBackendService } from '../../../../../../platform/agentHost/common/automation.js';
import { IRendererHostService, type IRendererHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { ILogService, NullLoggerService } from '../../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { ILayoutService } from '../../../../../../platform/layout/browser/layoutService.js';
import { INotificationService, Severity, type INotificationHandle, type INotification } from '../../../../../../platform/notification/common/notification.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { IMenuService } from '../../../../../../platform/actions/common/actions.js';
import { MenuService } from '../../../../../../platform/actions/common/menuService.js';
import { CommandService } from '../../../../../../workbench/services/commands/common/commandService.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { BrowserStorageService } from '../../../../../../workbench/services/storage/browser/storageService.js';
import { IChatSessionNavigationService } from '../../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IAutomationService } from '../../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationDialogService } from '../../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IAutomationRunner } from '../../../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { ViewsRegistry } from '../../../../../../workbench/common/views.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../../workbench/common/contributions.js';
import { ISessionsService, SessionsService } from '../../../../../services/sessions/browser/sessionsService.js';
import type { ISessionsManagementService } from '../../../../../services/sessions/common/sessionsManagement.js';
import type { IActiveSessionThread, ISession, IUntitledChatSession } from '../../../../../services/sessions/common/session.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import type { ISessionsProvider } from '../../../../../services/sessions/common/sessionsProvider.js';
import { ICustomViewService } from '../../../../../services/customView/browser/customViewService.js';
import { CustomViewGridPart } from '../../../../../browser/parts/customViewGridPart.js';
import { AgentHostAutomationStore } from '../../../../providers/agentHost/browser/agentHostAutomationStore.js';

const parameters = new URLSearchParams(location.search);

if (parameters.get('locale') === 'zh-CN') {
	const bundles: Record<string, Record<string, string>> = { ...translations };
	for (const [bundle, messages] of Object.entries(workbenchTranslations)) { bundles[bundle] = { ...bundles[bundle], ...messages }; }
	setNlsMessages('zh-CN', bundles);
	document.documentElement.lang = 'zh-CN';
}

await import('../../../browser/automations.contribution.js');

await import('../../../../sessions/browser/sessions.contribution.js');

const resources = new DisposableStore();

const services = resources.add(new InstantiationService());

const root = document.createElement('main');
root.className = 'ash-sessions-window ash-workbench';

root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:var(--ash-editor-background);color:var(--ash-foreground)';

document.body.append(root);
setARIAContainer(root);

const theme = resources.add(new TestThemeService(({ dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme } as const)[parameters.get('theme') as 'dark'] ?? lightColorTheme));

resources.add(bindTestColorTheme(theme, root));
services.registerInstance(IThemeService, theme);

services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, workspaceId: 'automations', flushInterval: 0 })));

services.registerInstance(ILogService, new NullLoggerService());

services.registerInstance(ILayoutService, parameters.has('hosts') ? resources.add(new BrowserLayoutService({ root })) : { activeContainer: root } as ILayoutService);

const contexts = resources.add(new ContextKeyService());
services.registerInstance(IContextKeyService, contexts);

services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));

const errors: string[] = [];
const notificationService = resources.add(new TestNotificationService());
const notices: { message: string; actions: readonly IAction[]; closed: boolean; }[] = [];
const notify = (message: string, actions: readonly IAction[] = []): INotificationHandle => {
	const item = { message, actions, closed: false };
	notices.push(item);
	const handle = notificationService.notify({ severity: Severity.Info, message: message, actions: { primary: actions } });
	return { ...handle, close: () => { item.closed = true; handle.close(); } };
};
services.registerInstance(INotificationService, {
	error: (message: string, actions?: readonly IAction[]) => { errors.push(message); return notify(message, actions); }, warn: notify, info: notify, notify: (options: INotification) => {
		if (options.severity === Severity.Error) errors.push(String(options.message));
		return notify(String(options.message), options.actions?.primary);
	}
} as unknown as INotificationService);

let directory = '/captured';

const changed = resources.add(new Emitter<void>());

const connection = observableValue<'connecting' | 'connected' | 'disconnected'>('test', 'connected');

let plans: Automation[] = [{
	id: 'plan',
	revision: 1,
	status: 'enabled',
	createdAt: 1,
	updatedAt: 1,
	nextRunAt: null,
	definition: {
		title: 'Scheduled review',
		prompt: 'Review changes',
		directory: '/saved',
		session: { type: 'new' },
		schedule: { type: 'interval', anchor: 1, minutes: 60 }
	}
}];

let run: AutomationRun = {
	id: 'run',
	automationId: 'plan',
	revision: 1,
	definition: plans[0]!.definition,
	turnId: 'automation-turn',
	status: 'needsInput',
	scheduledAt: Date.parse('2026-10-14T16:00:00Z'),
	startedAt: Date.parse('2026-10-14T16:00:03Z'),
	finishedAt: null,
	sessionId: 'background-session',
	threadId: 'background-thread',
	message: null
};

if (parameters.has('empty')) plans = [];
if (parameters.has('catalogue')) {
	const initial = plans[0]!;
	plans = [{
		...initial,
		nextRunAt: Date.parse('2026-10-15T16:00:00Z'),
		definition: { ...initial.definition, prompt: 'Review recent code changes for bugs and missing tests. Summarize actionable findings with file references.' }
	}, {
		...initial, id: 'briefing', status: 'paused', createdAt: 2,
		definition: {
			...initial.definition, title: 'Daily briefing',
			prompt: 'Summarize project activity, flag blockers, and suggest the next priorities.',
			directory: '/projects/workspace',
			schedule: { type: 'weekly', timezone: 'America/Los_Angeles', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 0 }
		}
	}];
	run = { ...run, scheduledAt: Date.parse('2026-10-14T16:00:00Z'), message: 'Review complete. Confirm whether to apply the suggested test updates.' };
}

const saved: AutomationDefinition[] = [];

let rejectSave = false;

let historyUnavailable = false;

let deferNextRun = false;

let stops = 0;

const backend: IAutomationBackendService = {
	onDidChange: changed.event,
	preview: async schedule => schedule.type === 'once' ? [schedule.at] : [Date.parse('2026-10-15T16:00:00Z'), Date.parse('2026-10-16T16:00:00Z'), Date.parse('2026-10-19T16:00:00Z')],
	readResult: async () => ({ output: 'Reviewed the changes. Added regression coverage for the scheduler.', files: [{ path: 'src/scheduler.test.ts', kind: 'added', additions: 24, deletions: 0 }] }),
	list: async () => plans,
	save: async (id, revision, definition, status) => {
		if (rejectSave) {
			rejectSave = false;
			throw new Error('Rejected test write');
		}
		if (revision && plans.find(plan => plan.id === id)?.revision !== revision) throw new Error('Conflicting test write');
		saved.push(definition);
		const plan = { id, revision: revision + 1, definition, status, createdAt: plans.find(plan => plan.id === id)?.createdAt ?? Date.now(), updatedAt: Date.now(), nextRunAt: null };
		plans = [...plans.filter(item => item.id !== id), plan];
		changed.fire();
		return plan;
	},
	delete: async id => {
		plans = plans.filter(item => item.id !== id);
		changed.fire();
	},
	run: async () => {
		run = deferNextRun ? { ...run, status: 'pending', sessionId: null, threadId: null } : { ...run, status: 'running' };
		deferNextRun = false;
		changed.fire();
		return run;
	},
	runs: async id => {
		if (historyUnavailable) throw new Error('History unavailable');
		return id === run.automationId ? [run] : [];
	},
	getRun: async id => {
		if (id !== run.id) throw new Error('Run unavailable');
		return run;
	},
	stop: async () => {
		stops++;
		run = { ...run, status: 'stopped' };
		changed.fire();
		return run;
	},
};

const hostChanges: string[] = [];
const hostTargets = [
	{ name: 'build-a', host: 'server-a', workspace: '/srv/project' },
	{ name: 'build-b', host: 'server-b', workspace: '/srv/project' },
];
const disconnected = createDisconnectedRendererApi();
const endpointChanges = resources.add(new Emitter<void>());
const endpoints = new Map<string, IRendererAgentHostConnection>();
services.registerInstance(ILanguageModelsConfigurationService, {
	onDidChangeModels: Event.None, getDefaultNewChatModel: () => undefined, rememberSelectedModel: () => { },
	isModelVisible: () => true, setModelVisible: async () => { },
});
const renderer: IRendererHost = parameters.has('hosts') ? {
	...disconnected, automation: backend,
	agentHosts: {
		get connections() { return [...endpoints.values()]; },
		onDidChangeConnections: endpointChanges.event,
		disconnect: id => { [...endpoints.values()].find(entry => entry.id === id)?.host?.dispose(); },
		reconnect: async () => { },
		connect: async target => {
			const key = agentHostConnectionAddress(target);
			const existing = endpoints.get(key)?.host;
			if (existing) return existing;
			hostChanges.push(`open:${target.name}`);
			const host: IRendererAgentHost = {
				id: target.name, connection: target,
				api: {
					...disconnected,
					appServer: { ...disconnected.appServer, getConnectionState: async () => 'ready' },
					automation: {
						...backend,
						list: async () => [{ ...plans[0]!, definition: { ...plans[0]!.definition, title: 'Shared review' } }],
						runs: async () => [],
						delete: async id => { hostChanges.push(`delete:${target.name}:${id}`); },
					},
				},
				...toDisposable(() => { hostChanges.push(`close:${target.name}`); endpoints.delete(key); endpointChanges.fire(); }),
			};
			endpoints.set(key, { id: host.id, connection: target, state: 'ready', host });
			endpointChanges.fire();
			return host;
		}
	},
} : { ...disconnected, automation: parameters.get('available') === '0' ? undefined : backend };
services.registerInstance(IRendererHostService, renderer);
services.registerInstance(IAgentHostConnectionsService, resources.add(services.createInstance(AgentHostConnectionsService)));

const registry = resources.add(new SessionsProvidersService());
services.registerInstance(ISessionsProvidersService, registry);

if (parameters.get('available') !== '0') {
	const store = resources.add(services.createInstance(AgentHostAutomationStore, 'host', connection));
	resources.add(registry.registerProvider({ id: 'host', label: 'Local host', order: 0, automations: store } as unknown as ISessionsProvider));
}

for (const [id, descriptor] of getSingletonServiceDescriptors()) if ([IAutomationService, IAutomationRunner, IAutomationDialogService, ICustomViewService].includes(id as typeof IAutomationService)) {
	services.registerSingleton(id, () => services.createInstance(descriptor));
}

const custom = services.get(ICustomViewService);

const sessionChanged = resources.add(new Emitter<void>());
let active: IActiveSessionThread | undefined;
let activeDraft = 'draft';
const drafts: IUntitledChatSession[] = [{
	untitledSessionId: 'draft', title: 'Draft', model: undefined, agent: undefined,
	get workspace() { return { type: 'local' as const, root: directory }; }
}];
const backgroundSession: ISession = { sessionId: 'background-session', title: 'Background session', status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: 'background-thread', origin: { type: 'root' }, status: 'active' }] };
const management = {
	sessions: [backgroundSession], untitledSessions: drafts, state: 'ready', materializedSessions: observableValue('materialized', new Map()),
	onDidChange: sessionChanged.event,
	get active() { return active; },
	get activeUntitledSession() { return drafts.find(draft => draft.untitledSessionId === activeDraft); },
	initialize: async () => { },
	selectThread(sessionId: string, threadId: string) {
		if (sessionId !== backgroundSession.sessionId || threadId !== 'background-thread') throw new Error('Unknown test conversation');
		active = { session: backgroundSession, threadId };
		activeDraft = '';
		sessionChanged.fire();
	},
	async openThread(sessionId: string, threadId: string) { management.selectThread(sessionId, threadId); },
	selectUntitledSession(id: string) { active = undefined; activeDraft = id; sessionChanged.fire(); },
	createUntitledSession(title: string) {
		const draft: IUntitledChatSession = { untitledSessionId: `draft-${drafts.length}`, title, model: undefined, agent: undefined, workspace: { type: 'local', root: directory } };
		drafts.push(draft);
		active = undefined;
		activeDraft = draft.untitledSessionId;
		sessionChanged.fire();
		return draft;
	},
} as unknown as ISessionsManagementService;
const sessions = resources.add(new SessionsService(management, services.get(IStorageService), custom));
services.registerInstance(ISessionsService, sessions);
await sessions.initialize();

const opened: string[][] = [];

services.registerInstance(IChatSessionNavigationService, {
	getConversations: () => [
		{ providerId: 'host', sessionId: 'local-session', threadId: 'local-thread', title: 'Local conversation' },
		{ sessionId: 'unowned-session', threadId: 'unowned-thread', title: 'Unknown host conversation' },
	],
	openConversation: async (sessionId: string, threadId: string, providerId?: string) => {
		if (providerId !== undefined && providerId !== 'host') throw new Error('Wrong conversation host');
		await sessions.openThread(sessionId, threadId);
		opened.push([sessionId, threadId]);
	}
} as unknown as IChatSessionNavigationService);

if (parameters.has('hosts')) {
	services.registerInstance(IFileService, resources.add(new FileService()));
	const files = resources.add(new AgentHostFileSystemProvider({ api: renderer.fs, resourceApi: renderer.resource }));
	services.registerInstance(IAgentHostFileSystemService, resources.add(services.createInstance(AgentHostFileSystemService, files, undefined)));
	services.registerInstance(IQuickInputService, resources.add(services.createInstance(QuickInputService)));
	services.registerInstance(IRemoteConnectionApi, {
		available: true, list: async () => hostTargets,
		save: async value => value, update: async (_name, value) => value, remove: async () => undefined,
		connect: async () => { throw new Error('The Agents host picker must retain this window'); },
	});
	services.registerInstance(IRemoteConnectionService, resources.add(services.createInstance(RemoteConnectionService)));
	const { SSHAgentHostContribution } = await import('../../../../providers/remoteAgentHost/browser/sshAgentHost.contribution.js');
	resources.add(services.createInstance(SSHAgentHostContribution));
}

const commands = resources.add(new CommandService(services));
services.registerInstance(ICommandService, commands);

services.registerInstance(IMenuService, new MenuService(commands, contexts));

const part = resources.add(services.createInstance(CustomViewGridPart, root));
part.domNode.style.cssText = 'height:100%;width:100%';

resources.add(autorun(reader => {
	const opening = custom.activeCustomViewOpen.read(reader);
	part.setView(opening?.descriptor);
	part.setVisible(!!opening);
	if (opening?.source === 'explicit') part.focusActiveView();
}));

resources.add(addDisposableListener(window, 'resize', () => part.layout({ width: innerWidth, height: innerHeight })));

const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.automationsCustomView']));

host.advance(WorkbenchPhase.BlockRestore);

await services.get(IAutomationService).refresh();

const registered = registry.getProviders().length > 0;

if (registered) await commands.executeCommand('sessionsView.manageAutomations');

declare global {
	interface Window {
		ashAutomations: {
			manageHosts(): Promise<unknown>; connectedHosts(): readonly string[]; hostChanges: readonly string[];
			registered: boolean; workbenchRegistered: boolean; saved: AutomationDefinition[]; opened: string[][]; errors: string[];
			notifications(): { message: string; closed: boolean; }[]; openNotification(): Promise<void>; refresh(): Promise<void>; rename(): Promise<void>;
			selectDirectory(value: string): void; help(): { help: string; view: string; }; rejectSave(): void;
			remoteEdit(): Promise<void>; disconnect(): void; reopen(): Promise<unknown>; stops(): number; finish(): Promise<void>;
			back(): void; forward(): void; openDraft(): void; selectedTitle(): string | undefined;
			failHistory(): void; retryHistory(): Promise<void>; deferRun(): void; failRun(): Promise<void>;
		};
	}
}

window.ashAutomations = {
	manageHosts: () => commands.executeCommand('sessions.action.manageAgentHosts'),
	connectedHosts: () => registry.getProviders().map(provider => provider.label),
	hostChanges,
	registered,
	workbenchRegistered: !!ViewsRegistry.getViewContainer('ash.automation'),
	saved,
	opened,
	errors,
	notifications: () => notices.map(({ message, closed }) => ({ message, closed })),
	async openNotification() { await notices.at(-1)?.actions[0]?.run(); },
	async refresh() { await services.get(IAutomationService).refresh(); },
	async rename() {
		plans = plans.map(plan => ({ ...plan, revision: plan.revision + 1, definition: { ...plan.definition, title: 'Updated review', prompt: 'Updated instructions' } }));
		await services.get(IAutomationService).refresh();
	},
	selectDirectory(value) { directory = value; },
	rejectSave() { rejectSave = true; },
	failHistory() { historyUnavailable = true; },
	async retryHistory() { historyUnavailable = false; await services.get(IAutomationService).refresh(); },
	deferRun() { deferNextRun = true; },
	async failRun() { run = { ...run, status: 'failed', message: 'Could not create session' }; await services.get(IAutomationService).refresh(); },
	back() { sessions.navigateBack(); },
	forward() { sessions.navigateForward(); },
	openDraft() { sessions.openNewSession('New draft'); },
	selectedTitle() { return sessions.activeSelection?.kind === 'untitled' ? sessions.activeSelection.session.title : sessions.activeSelection?.active.session.title; },
	async remoteEdit() {
		plans = plans.map(plan => ({ ...plan, revision: plan.revision + 1 }));
		await services.get(IAutomationService).refresh();
	},
	disconnect() { connection.set('disconnected', undefined); },
	reopen() { return commands.executeCommand('sessionsView.manageAutomations'); },
	stops() { return stops; },
	async finish() {
		run = { ...run, status: 'completed', message: null, finishedAt: Date.now() };
		await services.get(IAutomationService).refresh();
	},
	help() {
		const content = (type: AccessibleViewType): string => {
			const provider = AccessibleViewRegistry.getImplementations().find(item => item.name === `sessionsAutomations${type}`)?.getProvider(services);
			if (!provider) throw new Error('Missing accessibility provider');
			try { return provider.provideContent(); } finally { provider.dispose(); }
		};
		return { help: content(AccessibleViewType.Help), view: content(AccessibleViewType.View) };
	},
};

window.addEventListener('pagehide', () => resources.dispose(), { once: true });

document.body.dataset.ready = 'true';
