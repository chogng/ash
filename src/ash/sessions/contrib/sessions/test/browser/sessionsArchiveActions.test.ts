import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { ChatSessionArchiveActionWordingSettingId } from '../../../../../platform/chat/common/sessionArchiveActions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService, type IConfirmationDialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { ChatAgent } from '../../../../../workbench/services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { WorkbenchConfigurationService } from '../../../../../workbench/services/configuration/browser/configurationService.js';
import { initializeTestLocalization } from '../../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import '../../../../../workbench/contrib/chat/browser/chat.shared.contribution.js';
import '../../browser/views/sessionsViewActions.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import type { IActiveSessionThread, ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';

class Provider extends Disposable implements ISessionsProvider {
	readonly onDidChangeCatalog = Event.None;
	readonly onDidChangeSession = Event.None;
	items: ISession[] = [session('first'), session('second')];
	readonly archived: string[] = [];
	readonly restored: string[] = [];
	async list() { return this.items; }
	async listAgents(): Promise<readonly ChatAgent[]> { return []; }
	async readCatalog(id: string) { return this.items.find(session => session.sessionId === id); }
	async subscribe(value: ISession) { return { ...value, agentTree: [] }; }
	async unsubscribe() { }
	currentWorkspace() { return { type: 'current' as const }; }
	async create(): Promise<IActiveSessionThread> { throw new Error('The fixture starts with durable sessions'); }
	async setModel() { }
	async archive(value: ISession): Promise<ISession> {
		this.archived.push(value.sessionId);
		return this.replace({ ...value, status: 'archived', chats: value.chats.map(chat => ({ ...chat, status: 'archived' })) });
	}
	async restore(value: ISession): Promise<ISession> {
		this.restored.push(value.sessionId);
		return this.replace({ ...value, status: 'active', chats: value.chats.map(chat => ({ ...chat, status: chat.origin.type === 'root' ? 'active' : 'archived' })) });
	}
	async stop(value: ISession) { return this.archive(value); }
	async interrupt() { }
	private replace(value: ISession) { this.items = this.items.map(item => item.sessionId === value.sessionId ? value : item); return value; }
}

function session(id: string): ISession {
	return { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', chats: [{ threadId: `${id}-root`, origin: { type: 'root' }, status: 'active' }] };
}

async function fixture(wording: 'archive' | 'done', archived = false) {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(new InstantiationService());
	const provider = new Provider();
	if (archived) provider.items[0] = { ...provider.items[0]!, status: 'archived', chats: provider.items[0]!.chats.map(chat => ({ ...chat, status: 'archived' })) };
	const sessions = resources.add(new SessionsManagementService(provider));
	await sessions.initialize();
	const configuration = resources.add(new WorkbenchConfigurationService({ initialSnapshot: { revision: 1, document: { version: 1, source: JSON.stringify({ [ChatSessionArchiveActionWordingSettingId]: wording }) } } }));
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ISessionsManagementService, sessions);
	const opened: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		getConversations: () => [], appendToActiveDraft: () => { }, captureActiveDraft: async () => undefined,
		startVoiceConversation: async () => { throw new Error('Voice is outside this archive fixture'); },
		getActiveConversation: () => sessions.activeUntitledSession ? undefined : sessions.active && { sessionId: sessions.active.session.sessionId, threadId: sessions.active.threadId },
		openConversation: async (sessionId, threadId) => { opened.push(`${sessionId}/${threadId}`); await sessions.openThread(sessionId, threadId); },
	});
	const quickInput = resources.add(new TestQuickInputService({ container: dom.window.document.body, instantiationService: services }));
	services.registerInstance(IQuickInputService, quickInput);
	const commands = resources.add(new CommandService(services));
	return Object.assign(resources, { provider, sessions, services, commands, quickInput, opened, configuration });
}

async function pickerFor(input: TestQuickInputService): Promise<IQuickPick<IQuickPickItem>> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (input.currentQuickInput) return input.currentQuickInput as IQuickPick<IQuickPickItem>;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	throw new Error('The archived-session picker did not open');
}

for (const locale of ['en', 'zh-CN']) {
	for (const wording of ['archive', 'done'] as const) {
		test(`Session lifecycle commands use ${locale} ${wording} wording and preserve drafts`, async () => {
			initializeTestLocalization(locale);
			try {
				using current = await fixture(wording);
				const { sessions, services, commands, provider, quickInput } = current;
				const labels: string[] = [];
				let confirmed = false;
				services.registerInstance(IDialogService, { confirm: async (options: { primaryButton: string; }) => { labels.push(options.primaryButton); return { confirmed }; } } as unknown as IDialogService);
				await commands.executeCommand('agentSession.archive');
				assert.deepEqual(provider.archived, []);
				confirmed = true;
				await commands.executeCommand('agentSession.archive');
				assert.deepEqual(provider.archived, ['first']);
				assert.equal(labels[0], locale === 'en' ? wording === 'archive' ? 'Archive' : 'Mark as Done' : wording === 'archive' ? '归档' : '标记为完成');
				const draft = sessions.createUntitledSession('Preserved draft');
				const restore = commands.executeCommand('agentSession.restore');
				const picker = await pickerFor(quickInput);
				assert.equal(picker.items[0]?.label, locale === 'en' ? wording === 'archive' ? 'Unarchive All' : 'Restore All' : wording === 'archive' ? '全部取消归档' : '全部恢复');
				picker.selectedItems = [picker.items[0] as IQuickPickItem];
				picker.accept();
				await restore;
				assert.deepEqual(provider.restored, ['first']);
				assert.equal(sessions.activeUntitledSession, draft);
				assert.deepEqual(current.opened, []);
				await commands.executeCommand('workbench.action.chat.archiveAllAgentSessions');
				assert.equal(sessions.untitledSessions[0], draft);
				assert.deepEqual(provider.archived, ['first', 'first', 'second']);
			} finally { resetNlsResolver(); }
		});
	}
}

test('restoring a selected archived Session opens its canonical root', async () => {
	using current = await fixture('done', true);
	const restore = current.commands.executeCommand('agentSession.restore');
	const picker = await pickerFor(current.quickInput);
	const item = picker.items.find(item => 'sessionId' in item)! as IQuickPickItem;
	picker.activeItems = [item];
	picker.selectedItems = [item];
	picker.accept();
	await restore;
	assert.deepEqual({ restored: current.provider.restored, opened: current.opened, status: current.sessions.sessions[0]?.status }, { restored: ['first'], opened: ['first/first-root'], status: 'active' });
});

test('an archive confirmation retains its original Session target across navigation', async () => {
	using current = await fixture('done');
	const pending = new DeferredPromise<IConfirmationDialogResult>();
	const presented = new DeferredPromise<void>();
	current.services.registerInstance(IDialogService, { confirm: async () => { await presented.complete(); return pending.p; } } as unknown as IDialogService);
	const archiving = current.commands.executeCommand('agentSession.archive', { sessionId: 'first', threadId: 'first-root' });
	await presented.p;
	current.sessions.selectThread('second', 'second-root');
	await pending.complete({ confirmed: true });
	await archiving;
	assert.deepEqual(current.provider.archived, ['first']);
	assert.equal(current.sessions.active?.session.sessionId, 'second');
});

test('closing a pending restore picker does not open a conversation after its response arrives', async () => {
	using current = await fixture('done', true);
	const pending = new DeferredPromise<void>();
	const presented = new DeferredPromise<void>();
	const restore = current.provider.restore.bind(current.provider);
	current.provider.restore = async value => { await presented.complete(); await pending.p; return restore(value); };
	const restoring = current.commands.executeCommand('agentSession.restore');
	const picker = await pickerFor(current.quickInput);
	const item = picker.items.find(item => 'sessionId' in item)! as IQuickPickItem;
	picker.activeItems = [item];
	picker.selectedItems = [item];
	picker.accept();
	await presented.p;
	picker.hide();
	await pending.complete();
	await restoring;
	assert.deepEqual({ restored: current.provider.restored, opened: current.opened }, { restored: ['first'], opened: [] });
});

test('Session action wording rejects unsupported persisted values', async () => {
	using current = await fixture('done');
	await assert.rejects(current.configuration.updateValue(ChatSessionArchiveActionWordingSettingId, 'invalid'), /Choose Archive or Mark as Done/u);
	assert.equal(current.configuration.getValue(ChatSessionArchiveActionWordingSettingId), 'done');
});
