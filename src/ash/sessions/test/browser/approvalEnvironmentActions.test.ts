import { quickInputServiceTestControls } from '../../../platform/quickinput/test/browser/testQuickInputService.js';
import { QuickInputType, type IQuickPickDidAcceptEvent } from '../../../platform/quickinput/common/quickInput.js';
import { Event as QuickPickTestEvent } from '../../../base/common/event.js';
import { TestWorkspaceService } from '../../../workbench/services/configuration/test/common/testServices.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { createSshRemoteWorkspaceUri } from '../../../platform/remote/common/remote.js';
import type { SessionWorkspaceSelection } from '../../services/sessions/common/session.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickInputService as QuickInput, type IQuickPick, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { IApprovalEnvironmentService, type IApprovalEnvironmentService as EnvironmentService, type ReviewEnvironmentScanOptions, type ReviewEnvironmentInput } from '../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { CommandService } from '../../../workbench/services/commands/common/commandService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { productLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import '../../browser/actions/approvalEnvironmentActions.js';
import '../../browser/actions/sessionsChatActions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';

const scanOptions: ReviewEnvironmentScanOptions = { recentCommands: false, shellHistory: false, otherRepositories: false, summarizeWithModel: false, history: { sessions: 50, commandsPerSession: 200, days: null } };

test('permission command uses stable IDs and keeps bypass confirmation on the requesting composer', async () => {
	using services = new InstantiationService();
	using commands = new CommandService(services);
	services.registerInstance(ICommandService, commands);
	const choices: string[] = [];
	const model = { selectApprovalMode: (mode: string) => choices.push(mode) } as unknown as IChatWidgetModel;
	await commands.executeCommand('chat.permission', model, 'auto');
	await assert.rejects(commands.executeCommand('chat.permission', model, '1'), /Use \/permission/);
	let confirmed = false;
	services.registerInstance(IDialogService, { confirm: async () => ({ confirmed }) } as unknown as IDialogService);
	await commands.executeCommand('chat.permission', model, 'bypassPermissions');
	assert.deepEqual(choices, ['auto']);
	confirmed = true;
	await commands.executeCommand('chat.permission', model, 'bypassPermissions');
	assert.deepEqual(choices, ['auto', 'bypassPermissions']);
});

class Picker<T extends IQuickPickItem> extends Disposable implements IQuickPick<T> {
	readonly type = QuickInputType.QuickPick;
	activeItems: readonly T[] = [];
	focus(): void { }
	toggle(): void { }
	accept(inBackground = false): void { this.selectedItems = this.activeItems; this.accepted.fire({ inBackground }); }

	canSelectMany = false;
	selectedItems: readonly T[] = [];
	readonly onDidChangeSelection = QuickPickTestEvent.None;
	private readonly accepted = this._register(new Emitter<IQuickPickDidAcceptEvent>());
	private readonly hidden = this._register(new Emitter<void>());
	readonly onDidAccept = this.accepted.event;
	readonly onDidHide = this.hidden.event;
	readonly onDidChangeValue = Event.None;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	sortByLabel = true;
	items: readonly T[] = [];
	ariaLabel = '';
	placeholder = '';
	value = '';
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;
	constructor(private readonly select: (picker: Picker<T>) => void) { super(); }
	show(): void { queueMicrotask(() => this.select(this)); }
	hide(): void { this.hidden.fire(); }
	choose(label: string): void { const item = this.items.find(item => item.label === label); assert.ok(item, `Missing choice: ${label}`); this.selectedItems = [item]; this.accepted.fire({ inBackground: false }); }
}

test('Chinese environment preparation keeps scan scope explicit and saves only reviewed entries for its composer', async () => {
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
	using services = new InstantiationService();
	const choices = ['扫描项目…', '用当前任务模型整理资料', '包含项目近期会话', '会话上限：50', '每会话命令数：200', '时间范围：所有日期', '继续，生成草稿', 'curl', '接受为项目背景资料', '保存已接受的条目'];
	const seen: string[] = [];
	const sourceDetails: string[] = [];
	const input: QuickInput = {
		...quickInputServiceTestControls,

		createQuickPick: <T extends IQuickPickItem>(): IQuickPick<T> => new Picker<T>(picker => {
			seen.push(picker.ariaLabel);
			const source = picker.items.find(item => item.label === 'curl')?.detail;
			if (source) { sourceDetails.push(source); }
			if (picker.ariaLabel === '正在准备审核环境') { return; }
			picker.choose(choices.shift()!);
		}),
		input: async options => {
			const value = options?.title === '会话上限：50' ? '100' : options?.title === '每会话命令数：200' ? '500' : '90';
			assert.ok(options?.validateInput);
			for (const invalid of ['0', '-1', '1.5', '3651']) { assert.ok(await options.validateInput(invalid)); }
			assert.equal(await options.validateInput(value), undefined);
			if (options.title === '时间范围：所有日期') { assert.equal(await options.validateInput(''), undefined); }
			return value;
		},
	};
	const scans: ReviewEnvironmentScanOptions[] = [];
	const writes: Array<{ root: string; entries: readonly ReviewEnvironmentInput[]; }> = [];
	const service: EnvironmentService = {
		read: async scope => { assert.equal((scope as { root: string; }).root, '/chosen'); return { root: '/chosen', revision: 0, entries: [], scanOptions }; },
		scan: async (scope, id, options) => { assert.equal((scope as { root: string; }).root, '/chosen'); scans.push(options); return { root: '/chosen', id, baseRevision: 0, history: { sessionsAvailable: 120, sessionsScanned: 100, commandsAvailable: 1000, commandsScanned: 800, factsAvailable: 80, factsIncluded: 40 }, entries: [{ id: 'historical', kind: 'fact', title: 'curl', content: 'curl\nhttps://staging.example.com', source: { id: 'source', kind: 'recentCommand', label: 'thread-old:7:1000', revision: '123456789', command: { occurrences: 10, sessionCount: 2, samples: [{ sessionId: 'session-old', threadId: 'thread-old', turnId: 'turn-old', sequence: 7, recordedAtUnixMs: 1000 }] } }, accepted: false, current: true }] }; },
		cancel: async () => { assert.fail('a completed scan must not be cancelled'); },
		save: async (scope, _id, revision, entries, draftId) => { assert.equal(revision, 0); assert.ok(draftId); writes.push({ root: (scope as { root: string; }).root, entries }); return { root: '/chosen', revision: 1, entries: [], scanOptions }; },
	};
	services.registerInstance(IApprovalEnvironmentService, service);
	services.registerInstance(IQuickInputService, input);
	services.registerInstance(ISessionsManagementService, { sessions: [], activeUntitledSession: { workspace: { type: 'local', root: '/other' } }, untitledSessions: [{ untitledSessionId: 'chosen', workspace: { type: 'local', root: '/chosen' } }] } as unknown as ISessionsManagementService);
	const notices: string[] = [];
	services.registerInstance(INotificationService, { info: (message: string) => notices.push(message), error: (error: unknown) => { throw error; } } as unknown as INotificationService);
	using commands = new CommandService(services);
	try {
		await commands.executeCommand('chat.guardian.setup', { untitledSessionId: 'chosen', inputState: {} } as IChatWidgetModel);
		assert.deepEqual(scans, [{ ...scanOptions, recentCommands: true, history: { sessions: 100, commandsPerSession: 500, days: 90 } }]);
		assert.ok(seen.some(title => title.includes('100/120') && title.includes('800/1000') && title.includes('40/80')));
		assert.deepEqual(writes, [{ root: '/chosen', entries: [{ id: 'historical', kind: 'fact', title: 'curl', content: 'curl\nhttps://staging.example.com', sourceId: 'source' }] }]);
		assert.ok(seen.includes('审核环境：/chosen'));
		assert.ok(sourceDetails.some(detail => detail.includes('会话 session-old') && detail.includes('聊天 thread-old') && detail.includes('轮次 turn-old')));
		assert.deepEqual(notices, ['已为这个项目保存审核环境。']);
	} finally { resetNlsResolver(); }
});

test('closing a running environment scan calls the backend cancellation API and never saves', async () => {
	using services = new InstantiationService();
	const choices = ['Scan project…', 'Continue — generate draft'];
	let cancel: (() => void) | undefined;
	let cancelledId: string | undefined;
	services.registerInstance(IApprovalEnvironmentService, {
		read: async () => ({ root: '/chosen', revision: 0, entries: [], scanOptions }),
		scan: async (_scope, id) => new Promise((_resolve, reject) => { cancel = () => reject(new Error(`cancelled ${id}`)); }),
		cancel: async id => { cancelledId = id; cancel!(); },
		save: async () => { assert.fail('cancelled drafts must not be saved'); },
	} satisfies EnvironmentService);
	services.registerInstance(ISessionsManagementService, { sessions: [{ sessionId: 'chosen', workspace: { authorityId: 'local', root: '/chosen' }, chats: [{ threadId: 'thread-chosen' }] }], untitledSessions: [] } as unknown as ISessionsManagementService);
	services.registerInstance(INotificationService, { info() { }, error: (error: unknown) => { throw error; } } as unknown as INotificationService);
	using commands = new CommandService(services);
	// After cancellation the next environment picker closes, leaving the existing profile untouched.
	services.registerInstance(IQuickInputService, {
		...quickInputServiceTestControls,

		createQuickPick: <T extends IQuickPickItem>(): IQuickPick<T> => new Picker<T>(picker => {
			if (picker.ariaLabel === 'Preparing review environment' || choices.length === 0) { picker.hide(); }
			else { picker.choose(choices.shift()!); }
		}), input: async () => undefined,
	} satisfies QuickInput);
	await commands.executeCommand('chat.guardian.setup', { sessionId: 'chosen', threadId: 'thread-chosen', inputState: {} } as IChatWidgetModel);
	assert.ok(cancelledId);
});

test('rescanning replaces untouched observations while retaining explicit edits of the same source version', async () => {
	for (const edited of [false, true]) {
		using services = new InstantiationService();
		const choices = ['Scan project…', 'Continue — generate draft', ...(edited ? ['package.json', 'Edit description…'] : []), 'Scan project…', 'Continue — generate draft', edited ? 'package.json' : 'Build summary', 'Accept as project background', 'Save accepted entries'];
		let scans = 0;
		services.registerInstance(IApprovalEnvironmentService, {
			read: async () => ({ root: '/chosen', revision: 0, entries: [], scanOptions }),
			scan: async (_scope, id) => ({ root: '/chosen', id, baseRevision: 0, entries: [{ id: 'package', kind: 'fact', title: ++scans === 1 ? 'package.json' : 'Build summary', content: scans === 1 ? 'pnpm build' : 'pnpm build on Node', source: { id: 'source', kind: 'projectFile', label: 'package.json', revision: 'same-version' }, accepted: false, current: true }] }),
			cancel: async () => { assert.fail('completed scans must not be cancelled'); },
			save: async (_scope, _id, _revision, entries) => {
				assert.equal(entries[0]?.content, edited ? 'pnpm build with pinned Node' : 'pnpm build on Node');
				return { root: '/chosen', revision: 1, entries: [], scanOptions };
			},
		} satisfies EnvironmentService);
		services.registerInstance(ISessionsManagementService, { untitledSessions: [{ untitledSessionId: 'chosen', workspace: { type: 'local', root: '/chosen' } }] } as unknown as ISessionsManagementService);
		services.registerInstance(INotificationService, { info() { }, error: (error: unknown) => { throw error; } } as unknown as INotificationService);
		services.registerInstance(IQuickInputService, {
			...quickInputServiceTestControls,

			createQuickPick: <T extends IQuickPickItem>(): IQuickPick<T> => new Picker<T>(picker => { if (picker.ariaLabel !== 'Preparing review environment') { picker.choose(choices.shift()!); } }),
			input: async () => 'pnpm build with pinned Node',
		} satisfies QuickInput);
		using commands = new CommandService(services);
		await commands.executeCommand('chat.guardian.setup', { untitledSessionId: 'chosen', inputState: {} } as IChatWidgetModel);
		assert.equal(scans, 2);
		assert.equal(choices.length, 0);
	}
});


test('review preparation refuses explicit, window and durable remote targets before contacting the backend', async () => {
	for (const scope of ['draft', 'window', 'thread'] as const) {
		using services = new InstantiationService();
		services.registerInstance(IQuickInputService, { ...quickInputServiceTestControls, createQuickPick() { assert.fail('remote scopes do not open project preparation'); }, input: async () => undefined } satisfies QuickInput);
		services.registerInstance(IApprovalEnvironmentService, {
			read: async () => { assert.fail('remote root must not be read by the local backend'); },
			scan: async () => { assert.fail('remote root must not be scanned'); }, cancel: async () => { assert.fail('no scan started'); },
			save: async () => { assert.fail('remote root must not be saved'); },
		} satisfies EnvironmentService);
		services.registerInstance(INotificationService, {} as INotificationService);
		services.registerInstance(ISessionsManagementService, {
			sessions: [{ sessionId: 'remote', workspace: { authorityId: 'ssh+build-host', root: '/same-as-local' }, chats: [{ threadId: 'remote-thread' }] }],
			untitledSessions: [{ untitledSessionId: 'chosen', workspace: scope === 'window' ? { type: 'current' } : { type: 'ssh', host: 'build-host', root: '/same-as-local' } }],
		} as unknown as ISessionsManagementService);
		using context = new TestWorkspaceService({ id: 'remote-workspace', folders: [{ id: 'folder', index: 0, name: 'Project', uri: createSshRemoteWorkspaceUri('build-host', '/same-as-local') }] });
		services.registerInstance(IWorkspaceContextService, context);
		using commands = new CommandService(services);
		await assert.rejects(commands.executeCommand('chat.guardian.setup', { ...(scope === 'thread' ? { sessionId: 'remote', threadId: 'remote-thread' } : { untitledSessionId: 'chosen' }), inputState: {} } as IChatWidgetModel), /remote project is not supported yet/u);
	}
});

test('multiple project review selection binds the selected local folder and cancellation has no side effects', async () => {
	for (const cancelled of [false, true]) {
		using services = new InstantiationService();
		const workspace: SessionWorkspaceSelection = { type: 'multiple', folders: [{ label: 'First', target: { type: 'local', root: '/first' } }, { label: 'Selected', target: { type: 'local', root: '/selected' } }] };
		services.registerInstance(ISessionsManagementService, { sessions: [], untitledSessions: [{ untitledSessionId: 'chosen', workspace }] } as unknown as ISessionsManagementService);
		services.registerInstance(INotificationService, {} as INotificationService);
		const reads: unknown[] = [];
		services.registerInstance(IApprovalEnvironmentService, {
			read: async scope => { reads.push(scope); return { root: '/selected', revision: 1, entries: [], scanOptions }; },
			scan: async () => { assert.fail('selection does not start a scan'); }, cancel: async () => { assert.fail('no scan started'); },
			save: async () => { assert.fail('selection does not save a profile'); },
		} satisfies EnvironmentService);
		services.registerInstance(IQuickInputService, {
			...quickInputServiceTestControls,
			createQuickPick: <T extends IQuickPickItem>(): IQuickPick<T> => new Picker<T>(picker => {
				if (!cancelled && picker.ariaLabel === 'Choose the project to prepare') picker.choose('Selected'); else picker.hide();
			}), input: async () => undefined,
		} satisfies QuickInput);
		using commands = new CommandService(services);
		await commands.executeCommand('chat.guardian.setup', { untitledSessionId: 'chosen', inputState: {} } as IChatWidgetModel);
		assert.deepEqual(reads, cancelled ? [] : [{ type: 'directory', root: '/selected' }]);
	}
});
