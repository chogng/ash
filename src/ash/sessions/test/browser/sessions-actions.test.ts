import { constObservable } from '../../../base/common/observable.js';
import { quickInputServiceTestControls } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, QuickInputHideReason, type IQuickInput, type IQuickInputHideEvent, type IQuickPickDidAcceptEvent } from '../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../base/common/event.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../workbench/contrib/chat/common/chat.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { SHOW_SESSIONS_PICKER_COMMAND_ID } from '../../contrib/sessions/browser/sessionsActions.js';
import '../../browser/actions/sessionsChatActions.js';
import '../../contrib/sessions/browser/sessionDetailsAction.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { NEW_SESSION_ACTION_ID } from '../../contrib/chat/common/constants.js';
import '../../contrib/chat/browser/chat.contribution.js';
import { registerNewChatActions } from '../../../workbench/contrib/chat/browser/actions/chatNewActions.js';
import { registerChatActions } from '../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { IChatSessionNavigationService } from '../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { ISessionsService } from '../../../sessions/services/sessions/browser/sessionsService.js';
import type { ISession } from '../../../sessions/services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../sessions/services/sessions/common/sessionsManagement.js';
import { ILanguageModelsService } from '../../../workbench/contrib/chat/common/languageModels.js';
import type { ApprovalReviewModelSelection } from '../../../platform/models/common/agentModels.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, localize, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { approvalModeDefinitions, type ApprovalMode } from '../../../platform/agentHost/common/approvalModes.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../services/sessions/browser/sessionsProvidersService.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { ISessionsLayoutService } from '../../services/layout/common/sessionsLayoutService.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { ISessionGroupsService } from '../../services/sessions/browser/sessionGroupsService.js';
import { IProjectService, type Project } from '../../../platform/projects/common/projectService.js';
import '../../contrib/sessions/browser/views/sessionGroupAppearancePicker.js';

registerNewChatActions();
registerChatActions();

test('permission commands use shared Chinese copy and require confirmation only for Bypass', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using services = new InstantiationService();
	let confirmed = false;
	const confirmations: string[] = [];
	services.registerInstance(IDialogService, {
		confirm: async (options: { primaryButton: string; }) => { confirmations.push(options.primaryButton); return { confirmed }; },
	} as unknown as IDialogService);
	using commands = new CommandService(services);
	const selections: ApprovalMode[] = [];
	const otherSelections: ApprovalMode[] = [];
	const model = { composerGeneration: 0, inputState: { aiDisabled: false }, selectApprovalMode: (mode: ApprovalMode) => selections.push(mode) } as unknown as IChatWidgetModel;
	const otherModel = { composerGeneration: 0, inputState: { aiDisabled: false }, selectApprovalMode: (mode: ApprovalMode) => otherSelections.push(mode) } as unknown as IChatWidgetModel;
	try {
		assert.deepEqual(approvalModeDefinitions.map(definition => [localize(definition.label.key, definition.label.text), localize(definition.description.key, definition.description.text)]), [
			['自动', '自动审核操作，无法判断时询问你'],
			['手动', '操作需要授权时由你确认'],
			['跳过权限审批', '跳过大部分审批，访问范围限制仍然有效'],
		]);
		await commands.executeCommand('sessions.chat.permission.auto', model);
		await commands.executeCommand('sessions.chat.permission.manual', otherModel);
		await commands.executeCommand('sessions.chat.permission.bypassPermissions', model);
		assert.deepEqual(selections, ['auto']);
		confirmed = true;
		await commands.executeCommand('sessions.chat.permission.bypassPermissions', model);
		assert.deepEqual(selections, ['auto', 'bypassPermissions']);
		assert.deepEqual(otherSelections, ['manual']);
		assert.deepEqual(confirmations, ['跳过权限审批', '跳过权限审批']);
	} finally { resetNlsResolver(); }
});

test('Sessions owns its New Session command and routes explicit provider choices', async () => {
	const onDidChange = new Emitter<void>();
	const created: Array<string | undefined> = [];
	const viewService: ISessionsService = {
		chatSelection: constObservable(undefined), getChatSelection: () => undefined, async restoreChatSelection() { },
		openChatDraft() { }, selectChatThread() { }, setChatModelPreference() { },
		navigationRevision: 0,
		getLastViewedAt: () => undefined,
		markVisibleThreadViewed() { },
		getSelection() { return { visibleSelections: [], activeSelection: undefined }; },
		async openThread() { },
		onDidChange: onDidChange.event,
		visibleSelections: [],
		activeSelection: undefined,
		canNavigateBack: false,
		canNavigateForward: false, recentSessions: [],
		async initialize() { },
		async openSession() { },
		async openUntitledSession() { },
		openNewSession(_title, options) {
			created.push(options?.providerId);
			return { untitledSessionId: `untitled-${created.length}`, title: 'New code session', model: undefined, agent: undefined, workspace: { type: 'current' } };
		},
		activateSelection() { },
		closeVisibleSelection() { },
		async reopenLastClosedItem() { },
		async openPreviousSession() { },
		async openNextSession() { },
	};
	const services = new InstantiationService();
	services.registerInstance(ISessionsService, viewService);
	using providers = new SessionsProvidersService();
	services.registerInstance(ISessionsProvidersService, providers);
	using commands = new CommandService(services);

	await commands.executeCommand(NEW_SESSION_ACTION_ID);

	await commands.executeCommand(NEW_SESSION_ACTION_ID, 'ssh-host');
	await assert.rejects(commands.executeCommand(NEW_SESSION_ACTION_ID, {}), TypeError);
	assert.deepEqual(created, [undefined, 'ssh-host']);
	onDidChange.dispose();
});

test('navigation New uses the active entry owner before the default ChatGPT entry', async () => {
	using services = new InstantiationService();
	const calls: string[] = [];
	let entryCommand: string | undefined = 'test.entry.newChat';
	services.registerInstance(IContextKeyService, { getValue: () => 'chat' } as unknown as IContextKeyService);
	services.registerInstance(ISessionsLayoutService, { get newSessionCommand() { return entryCommand; } } as ISessionsLayoutService);
	using native = CommandsRegistry.register('test.entry.newChat', () => { calls.push('native'); });
	using chatgpt = CommandsRegistry.register('sessions.open.new', () => { calls.push('chatgpt'); });
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	await commands.executeCommand('sessions.newSession');
	entryCommand = undefined;
	await commands.executeCommand('sessions.newSession');
	assert.deepEqual(calls, ['native', 'chatgpt']);
});

test('Code navigation New creates a Session and opens its workspace without the shared Chat view', async () => {
	using services = new InstantiationService();
	const calls: string[] = [];
	const target = { providerId: 'test', workspace: { type: 'local', root: '/project' } } as const;
	let revision = 0;
	let switchDuringProbe = false;
	let switchPageDuringProbe = false;
	using contextChanged = new Emitter<{ keys: ReadonlySet<string>; affectsSome: () => boolean; }>();
	services.registerInstance(ISessionsManagementService, {
		async resolveNewSessionTarget() {
			if (switchDuringProbe) revision++;
			if (switchPageDuringProbe) contextChanged.fire({ keys: new Set(['sessions.activity.customizeSelected']), affectsSome: () => true });
			return target;
		}
	} as unknown as ISessionsManagementService);
	services.registerInstance(IContextKeyService, { getValue: () => 'code', onDidChangeContext: contextChanged.event } as unknown as IContextKeyService);
	services.registerInstance(ISessionsLayoutService, { newSessionCommand: undefined } as ISessionsLayoutService);
	services.registerInstance(ISessionsService, {
		get navigationRevision() { return revision; }, openNewSession: (_title: undefined, options: unknown) => {
			assert.deepEqual(options, target);
			calls.push('create');
			return { untitledSessionId: 'draft' };
		}
	} as unknown as ISessionsService);
	using providers = new SessionsProvidersService();
	services.registerInstance(ISessionsProvidersService, providers);
	services.registerInstance(ILayoutService, { focus: () => calls.push('focus') } as unknown as ILayoutService);
	using code = CommandsRegistry.register('sessions.open.code', () => { calls.push('code'); });
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	await commands.executeCommand('sessions.newSession');
	assert.deepEqual(calls, ['create', 'code', 'focus']);
	calls.length = 0;
	switchDuringProbe = true;
	await commands.executeCommand('sessions.newSession');
	assert.deepEqual(calls, []);
	switchDuringProbe = false;
	switchPageDuringProbe = true;
	await commands.executeCommand('sessions.newSession');
	assert.deepEqual(calls, []);
});

test('shared Chat commands coexist with Sessions actions and delegate to the window owner', async () => {
	using services = new InstantiationService();
	const created: Array<string | undefined> = [];
	const opened: string[] = [];
	const focus: string[] = [];
	const input = new TestQuickInputService();
	services.registerInstance(IQuickInputService, input);
	services.registerInstance(ISessionsService, {
		openNewSession: (_title: string, options?: { providerId?: string; }) => { created.push(options?.providerId); return { untitledSessionId: 'draft' }; },
		recentSessions: [],
		openSession: async (sessionId: string, threadId: string, options: { reveal: 'code'; }) => {
			assert.equal(options.reveal, 'code');
			opened.push(`${sessionId}/${threadId}`);
		},
	} as unknown as ISessionsService);
	services.registerInstance(ISessionsManagementService, {
		resolveNewSessionTarget: async () => ({ providerId: 'test', workspace: { type: 'current' } }),
		sessions: [
			{ sessionId: 'session', kind: 'code' as const, title: 'Session', status: 'active', workspace: { authorityId: 'local', root: '/workspace' }, chats: [{ threadId: 'thread', status: 'active', origin: { type: 'root' } }] },
			{ sessionId: 'legacy', kind: 'code' as const, title: 'Legacy session', status: 'active', chats: [{ threadId: 'legacy', status: 'active', origin: { type: 'root' } }] },
		],
	} as unknown as ISessionsManagementService);
	services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
	services.registerInstance(IContextKeyService, { getValue: () => 'code', onDidChangeContext: Event.None } as unknown as IContextKeyService);
	services.registerInstance(ISessionsLayoutService, { newSessionCommand: undefined } as unknown as ISessionsLayoutService);
	services.registerInstance(ILayoutService, { focus: () => focus.push('composer') } as unknown as ILayoutService);
	using code = CommandsRegistry.register('sessions.open.code', () => { focus.push('code'); });
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	services.registerInstance(IChatSessionNavigationService, {
		createNewConversation: async () => { await commands.executeCommand('sessions.newSession'); },
		showConversationHistory: () => commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID),
	} as unknown as IChatSessionNavigationService);
	assert.equal(NEW_CHAT_COMMAND_ID, 'workbench.action.chat.newChat');
	assert.equal(await commands.executeCommand('workbench.action.chat.newChat'), true);
	assert.deepEqual(created, ['test']);
	assert.deepEqual(focus, ['code', 'composer']);
	await commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID);
	assert.deepEqual(input.picker?.items.map(item => item.label), ['Session', 'Legacy session']);
	input.picker!.acceptFirst();
	assert.deepEqual(opened, ['session/thread']);
});

test('Sessions History ranks recent active chats ahead of unvisited chats', async () => {
	const opened: Array<{ sessionId: string; threadId: string; }> = [];
	const quickInput = new TestQuickInputService();
	const sessions: readonly ISession[] = [
		{
			sessionId: 'session-1', kind: 'code' as const,
			title: 'First Session',
			status: 'active',
			nextApprovalMode: 'manual',
			chats: [
				{ threadId: 'thread-1', origin: { type: 'root' }, status: 'active' },
				{ threadId: 'thread-2', origin: { type: 'root' }, status: 'archived' },
			],
		},
		{
			sessionId: 'recent', kind: 'code' as const,
			title: 'Recent Session',
			status: 'active',
			nextApprovalMode: 'manual',
			chats: [{ threadId: 'root', origin: { type: 'root' }, status: 'active' }],
		},
		{
			sessionId: 'session-2', kind: 'code' as const,
			title: 'Archived Session',
			status: 'archived',
			nextApprovalMode: 'manual',
			chats: [{ threadId: 'thread-3', origin: { type: 'root' }, status: 'active' }],
		},
	];
	const services = new InstantiationService();
	services.registerInstance(ISessionsManagementService, { sessions, onDidChange: Event.None } as ISessionsManagementService);
	services.registerInstance(ISessionsService, {
		recentSessions: [
			{ sessionId: 'session-2', threadId: 'thread-3' },
			{ sessionId: 'recent', threadId: 'root' },
		],
		openSession: async (sessionId: string, threadId: string) => { opened.push({ sessionId, threadId }); },
	} as unknown as ISessionsService);
	services.registerInstance(IQuickInputService, quickInput);
	using commands = new CommandService(services);

	await commands.executeCommand('sessions.chat.history');

	assert.equal(quickInput.picker?.placeholder, 'Select a session');
	assert.deepEqual(quickInput.picker?.items.map(item => item.label), ['Recent Session', 'First Session']);
	quickInput.picker?.acceptFirst();
	assert.deepEqual(opened, [{ sessionId: 'recent', threadId: 'root' }]);
});

test('Session History shows each branch management state in Chinese before opening details', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using services = new InstantiationService();
	const quickInput = new TestQuickInputService();
	const opened: string[] = [];
	services.registerInstance(ISessionsManagementService, {
		sessions: [{
			sessionId: 'branch-session', kind: 'code' as const, title: 'Branch session', status: 'active', nextApprovalMode: 'manual',
			chats: [
				{ threadId: 'root', origin: { type: 'root' }, status: 'active', management: { status: 'readyForReview', statusChangedAtUnixMs: 10 } },
				{ threadId: 'fork', title: '独立分支名称', origin: { type: 'fork', parentThreadId: 'root', parentSequence: 1 }, status: 'active', management: { status: 'needsInput', statusChangedAtUnixMs: 20, activity: { type: 'question', text: 'Choose a path' } } },
			],
		}], onDidChange: Event.None
	} as unknown as ISessionsManagementService);
	services.registerInstance(ISessionsService, { recentSessions: [], openSession: async (_sessionId: string, threadId: string) => { opened.push(threadId); } } as unknown as ISessionsService);
	services.registerInstance(IQuickInputService, quickInput);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID);
		assert.deepEqual(quickInput.picker?.items.map(item => ({ label: item.label, description: item.description, detail: item.detail })), [
			{ label: 'Branch session', description: '分支 2 · 独立分支名称 · 需要回应', detail: 'Choose a path' },
			{ label: 'Branch session', description: '分支 1 · 待审阅', detail: undefined },
		]);
		assert.deepEqual(opened, []);
		quickInput.picker?.hide();
	} finally { resetNlsResolver(); }
});

test('Session History has an unread group for new background activity since the last visit', async () => {
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const quickInput = new TestQuickInputService();
	const catalog: ISession[] = ['unread', 'read', 'working'].map(sessionId => ({
		sessionId, kind: 'code' as const, title: sessionId, status: 'active', nextApprovalMode: 'manual',
		chats: [{
			threadId: 'root', origin: { type: 'root' }, status: 'active',
			updatedAt: new Date(200), executionStatus: sessionId === 'working' ? 'running' : 'completed'
		}],
	}));
	services.registerInstance(ISessionsManagementService, { sessions: catalog, onDidChange: Event.None } as unknown as ISessionsManagementService);
	services.registerInstance(ISessionsService, {
		recentSessions: [{ sessionId: 'unread', threadId: 'root' }],
		getLastViewedAt: (entry: { sessionId: string; }) => entry.sessionId === 'read' ? 300 : 100,
	} as unknown as ISessionsService);
	services.registerInstance(IQuickInputService, quickInput);
	await commands.executeCommand(SHOW_SESSIONS_PICKER_COMMAND_ID);
	assert.deepEqual(quickInput.picker?.items.map(item => item.label), ['Unread', 'unread', 'Other sessions', 'read', 'working']);
	quickInput.picker?.hide();
});

test('Session Details opens a localized read-only snapshot of active user sessions', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using services = new InstantiationService();
		using commands = new CommandService(services);
		const opened: Parameters<IEditorService['openEditor']>[] = [];
		const local: ISession = {
			sessionId: 'local', kind: 'code' as const, title: 'Local\nTask', status: 'active', nextApprovalMode: 'manual', chats: [],
			workspace: { authorityId: 'local', root: 'C:\\work' },
		};
		services.registerInstance(ISessionsManagementService, {
			sessions: [
				local,
				{ ...local, sessionId: 'archived', title: 'Archived task', status: 'archived' },
				{ ...local, sessionId: 'automation', title: 'Automated task', source: 'automation' },
			]
		} as unknown as ISessionsManagementService);
		services.registerInstance(IEditorService, {
			openEditor: async (...args: Parameters<IEditorService['openEditor']>) => { opened.push(args); },
		} as unknown as IEditorService);
		await commands.executeCommand('sessions.showSessionDetails');
		const [[input, options]] = opened;
		assert.equal(input.label, '会话详情');
		assert.equal(input.readOnly, true);
		assert.equal(options?.pinned, true);
		assert.match(input.initialText ?? '', /会话：Local Task\n工作目录：C:\\work\n资源：ash-agent-session:/);
		assert.doesNotMatch(input.initialText ?? '', /Archived task|Automated task/);
	} finally { resetNlsResolver(); }
});

test('Show Conversation Recap opens the latest saved text for the selected branch', async () => {
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const opened: Parameters<IEditorService['openEditor']>[] = [];
	const session: ISession = {
		sessionId: 'session', kind: 'code' as const, title: 'Task', status: 'active', nextApprovalMode: 'manual',
		chats: [
			{ threadId: 'root', origin: { type: 'root' }, status: 'active', recap: 'Root recap' },
			{ threadId: 'branch', origin: { type: 'root' }, status: 'active', recap: 'Branch recap' },
		],
	};
	services.registerInstance(ISessionsService, {
		activeSelection: { kind: 'session', active: { session: { ...session, chats: [] }, threadId: 'branch' } },
	} as unknown as ISessionsService);
	services.registerInstance(ISessionsManagementService, { sessions: [session] } as unknown as ISessionsManagementService);
	services.registerInstance(IEditorService, {
		openEditor: async (...args: Parameters<IEditorService['openEditor']>) => { opened.push(args); },
	} as unknown as IEditorService);
	await commands.executeCommand('sessions.showConversationRecap');
	assert.equal(opened[0]?.[0].initialText, 'Branch recap');
	assert.equal(opened[0]?.[0].readOnly, true);
});

test('Moving a conversation follows its destination only if navigation stayed on the original conversation', async () => {
	using services = new InstantiationService();
	using commands = new CommandService(services);
	const source: ISession = { sessionId: 'source', kind: 'code' as const, title: 'Source', status: 'active', nextApprovalMode: 'manual', chats: [] };
	const destination: ISession = { ...source, sessionId: 'destination', title: 'Destination' };
	const calls: string[][] = [];
	let navigationRevision = 0;
	let navigateDuringMove = false;
	services.registerInstance(IQuickInputService, new TestQuickInputService(['Destination', 'Destination']));
	services.registerInstance(ISessionsService, {
		activeSelection: { kind: 'session', active: { session: source, threadId: 'thread' } },
		get navigationRevision() { return navigationRevision; },
		openThread: async (...ids: string[]) => { calls.push(['open', ...ids]); },
	} as unknown as ISessionsService);
	services.registerInstance(ISessionsManagementService, {
		getChatMoveDestinations: (sessionId: string, threadId: string) => sessionId === source.sessionId && threadId === 'thread' ? [destination] : [],
		moveChat: async (...ids: string[]) => {
			calls.push(['move', ...ids]);
			if (navigateDuringMove) navigationRevision++;
		},
	} as unknown as ISessionsManagementService);

	const context = { sessionId: source.sessionId, threadId: 'thread' };
	await commands.executeCommand('sessions.list.moveChatToSession', context);
	navigateDuringMove = true;
	await commands.executeCommand('sessions.list.moveChatToSession', context);

	assert.deepEqual(calls, [
		['move', 'source', 'thread', 'destination'],
		['open', 'destination', 'thread'],
		['move', 'source', 'thread', 'destination'],
	]);
});

test('The group appearance picker localizes choices and saves or resets the selected field', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using services = new InstantiationService();
		using commands = new CommandService(services);
		const input = new TestQuickInputService(['聊天', '红色', '默认', null]);
		services.registerInstance(IQuickInputService, input);
		const updates: unknown[][] = [];
		services.registerInstance(ISessionGroupsService, {
			groups: [{ sectionId: 'review', name: 'Review', sessionIds: [], color: 'charts.orange' }],
			setGroupAppearance: async (...args: unknown[]) => { updates.push(args); },
		} as unknown as ISessionGroupsService);
		await commands.executeCommand('sessions.list.changeGroupAppearance', 'review', 'icon');
		assert.equal(input.picker?.ariaLabel, '更改分组图标');
		assert.ok(input.picker?.items.some(item => item.id === 'circle-filled' && item.iconClass));
		await commands.executeCommand('sessions.list.changeGroupAppearance', 'review', 'color');
		assert.equal(input.picker?.activeItems[0]?.id, 'charts.orange');
		assert.deepEqual(input.picker?.items.filter(item => item.iconColor).map(item => item.iconColor?.id), [
			'terminal.ansiBlack', 'terminal.ansiRed', 'terminal.ansiGreen', 'terminal.ansiYellow',
			'terminal.ansiBlue', 'terminal.ansiMagenta', 'terminal.ansiCyan', 'terminal.ansiWhite', 'charts.orange',
		]);
		await commands.executeCommand('sessions.list.changeGroupAppearance', 'review', 'icon');
		await commands.executeCommand('sessions.list.changeGroupAppearance', 'review', 'color');
		assert.deepEqual(updates, [['review', 'icon', 'chat'], ['review', 'color', 'terminal.ansiRed'], ['review', 'icon', undefined]]);
	} finally { resetNlsResolver(); }
});

test('The project appearance command uses the project revision and the shared localized picker', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	try {
		using services = new InstantiationService();
		using commands = new CommandService(services);
		const input = new TestQuickInputService(['聊天', '默认', null]);
		services.registerInstance(IQuickInputService, input);
		const project: Project = {
			id: 'review', revision: 3, name: 'Review', archived: false, createdAtMs: 1, updatedAtMs: 1, sessionCount: 0,
			description: '', materials: [], sessionIds: [], color: 'terminal.ansiRed',
		};
		const updates: unknown[][] = [];
		services.registerInstance(IProjectService, {
			read: async (id: string) => { assert.equal(id, project.id); return project; },
			setAppearance: async (...args: unknown[]) => { updates.push(args); },
		} as IProjectService);
		await commands.executeCommand('sessions.list.changeProjectAppearance', 'review', 'icon');
		assert.equal(input.picker?.ariaLabel, '更改项目图标');
		await commands.executeCommand('sessions.list.changeProjectAppearance', 'review', 'color');
		assert.equal(input.picker?.ariaLabel, '更改项目颜色');
		assert.equal(input.picker?.activeItems[0]?.id, 'terminal.ansiRed');
		await commands.executeCommand('sessions.list.changeProjectAppearance', 'review', 'color');
		assert.deepEqual(updates, [[project, 'icon', 'chat'], [project, 'color', undefined]]);
	} finally { resetNlsResolver(); }
});

class TestQuickInputService implements IQuickInputService {
	readonly quickAccess = quickInputServiceTestControls.quickAccess;
	readonly onShow = quickInputServiceTestControls.onShow;
	readonly onHide = quickInputServiceTestControls.onHide;
	readonly currentQuickInput = undefined;
	focus = quickInputServiceTestControls.focus;
	toggle = quickInputServiceTestControls.toggle;
	setAlignment = quickInputServiceTestControls.setAlignment;
	navigate = quickInputServiceTestControls.navigate;
	accept = quickInputServiceTestControls.accept;
	cancel = quickInputServiceTestControls.cancel;
	createQuickTree = quickInputServiceTestControls.createQuickTree;
	createQuickWidget = quickInputServiceTestControls.createQuickWidget;

	picker: TestQuickPick<IQuickPickItem> | undefined;
	constructor(private readonly labels: (string | null)[] = []) { }

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>(() => {
			const label = this.labels.shift();
			if (label) {
				picker.chooseItem(label);
			} else if (label === null) {
				picker.hide();
			}
		});
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
		return picker;
	}

	async input(): Promise<string | undefined> { return undefined; }
}

class TestQuickPick<TItem extends IQuickPickItem> extends Disposable implements IQuickPick<TItem> {
	title: string | undefined;
	description: string | undefined;
	step: number | undefined;
	totalSteps: number | undefined;
	buttons: IQuickInput['buttons'] = [];
	enabled = true;
	busy = false;
	contextKey: string | undefined;
	ignoreFocusOut = false;
	readonly onWillHide = Event.None;
	readonly onDispose = Event.None;
	readonly onDidTriggerButton = Event.None;
	willHide(): void { }
	didHide(): void { }
	readonly type = QuickInputType.QuickPick;
	activeItems: readonly TItem[] = [];
	focus(): void { }
	toggle(): void { }
	accept(inBackground = false): void { this.selectedItems = this.activeItems; this.acceptEmitter.fire({ inBackground }); }

	canSelectMany = false;
	selectedItems: readonly TItem[] = [];
	readonly onDidChangeSelection = QuickPickTestEvent.None;
	constructor(private readonly onShow: () => void) { super(); }
	private readonly acceptEmitter = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	private readonly hideEmitter = this._register(new Emitter<IQuickInputHideEvent>());
	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	readonly onDidChangeValue = Event.None;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	sortByLabel = true;
	items: readonly TItem[] = [];
	ariaLabel = '';
	placeholder = '';
	value = '';
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;

	acceptFirst(): void {
		const item = this.items[0];
		if (item) { this.selectedItems = [item]; this.acceptEmitter.fire({ inBackground: false }); }
	}

	chooseItem(label: string): void {
		const item = this.items.find(item => item.label === label);
		assert.ok(item, `Expected review choice: ${label}`);
		this.selectedItems = [item]; this.acceptEmitter.fire({ inBackground: false });
	}
	show(): void { this.onShow(); }
	hide(): void { this.hideEmitter.fire({ reason: QuickInputHideReason.Other }); }
}

test('Review settings select an independent connection, model and effort through the Chinese picker', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using services = new InstantiationService();
	const selections: ApprovalReviewModelSelection[] = [];
	const models = {
		readApprovalReviewModel: async () => ({ type: 'automatic' }),
		listModelProviders: async () => [{ provider: 'openai', connection: 'openai', displayName: 'OpenAI API', configured: true }],
		listModelCatalog: async () => [{ model: { provider: 'openai', model: 'gpt-6-luna' }, displayName: 'GPT-6 Luna', supportedReasoningEfforts: [{ effort: 'low' }, { effort: 'medium' }] }],
		setApprovalReviewModel: async (selection: ApprovalReviewModelSelection) => { selections.push(selection); },
	};
	services.registerInstance(ILanguageModelsService, models as unknown as ILanguageModelsService);
	const input = new TestQuickInputService(['OpenAI API', 'GPT-6 Luna', 'low', '自动（连接默认值）']);
	services.registerInstance(IQuickInputService, input);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand('sessions.chat.permission.reviewModel');
		assert.equal(input.picker?.ariaLabel, '审核思考强度');
		assert.deepEqual(selections, [{ type: 'explicit', connection: 'openai', model: { provider: 'openai', model: 'gpt-6-luna' }, reasoningEffort: 'low' }]);
		await commands.executeCommand('sessions.chat.permission.reviewModel');
		assert.deepEqual(selections[1], { type: 'automatic' });
	} finally { resetNlsResolver(); }
});
