import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
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
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { initializeTestLocalization } from '../../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import '../../../../../workbench/contrib/chat/browser/chat.shared.contribution.js';
import '../../browser/views/sessionsViewActions.js';
import { TestSessionsManagementService as SessionsManagementService } from '../../../../services/sessions/test/browser/testSessionsManagementService.js';
import type { IActiveSessionThread, ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';

class Provider extends Disposable implements ISessionsProvider {
	readonly id = 'test-provider';
	readonly label = 'Test provider';
	readonly order = 0;
	readonly onDidChangeCatalog = Event.None;
	readonly onDidChangeSession = Event.None;
	items: ISession[] = [session('first'), session('second')];
	readonly created: string[] = [];
	readonly archived: string[] = [];
	readonly restored: string[] = [];
	async list() {
		return this.items;
	}
	async listAgents(): Promise<readonly ChatAgent[]> {
		return [];
	}
	async readCatalog(id: string) {
		return this.items.find(session => session.sessionId === id);
	}
	async subscribe(value: ISession) {
		return { ...value, agentTree: [] };
	}
	async unsubscribe() {}
	currentWorkspace() {
		return { type: 'current' as const };
	}
	async create(title: string): Promise<IActiveSessionThread> {
		const value = { ...session(`created-${this.created.length}`), title };
		this.created.push(value.sessionId);
		this.items.push(value);
		return { session: value, threadId: value.chats[0]!.threadId };
	}
	async setModel() {}
	async renameSession(value: ISession, title: string): Promise<ISession> {
		const renamed = { ...value, title };
		this.items = this.items.map(item => (item.sessionId === value.sessionId ? renamed : item));
		return renamed;
	}
	async deleteSession(value: ISession): Promise<void> {
		this.items = this.items.filter(item => item.sessionId !== value.sessionId);
	}

	async archive(value: ISession): Promise<ISession> {
		this.archived.push(value.sessionId);
		return this.replace({
			...value,
			status: 'archived',
			chats: value.chats.map(chat => ({ ...chat, status: 'archived' })),
		});
	}
	async restore(value: ISession): Promise<ISession> {
		this.restored.push(value.sessionId);
		return this.replace({
			...value,
			status: 'active',
			chats: value.chats.map(chat => ({ ...chat, status: chat.origin.type === 'root' ? 'active' : 'archived' })),
		});
	}
	async stop(value: ISession) {
		return this.archive(value);
	}
	async interrupt() {}
	private replace(value: ISession) {
		this.items = this.items.map(item => (item.sessionId === value.sessionId ? value : item));
		return value;
	}
}

function session(id: string): ISession {
	return {
		sessionId: id,
		title: id,
		status: 'active',
		nextApprovalMode: 'manual',
		chats: [{ threadId: `${id}-root`, origin: { type: 'root' }, status: 'active' }],
	};
}

async function fixture(wording: 'archive' | 'done', archived = false) {
	const resources = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
	resources.add(toDisposable(() => dom.window.close()));
	const services = resources.add(new InstantiationService());
	const storage = resources.add(
		new BrowserStorageService({
			ownerWindow: dom.window as unknown as Window,
			workspaceId: 'session-actions',
			flushInterval: 0,
		}),
	);
	services.registerInstance(IStorageService, storage);
	const provider = new Provider();
	if (archived)
		provider.items[0] = {
			...provider.items[0]!,
			status: 'archived',
			chats: provider.items[0]!.chats.map(chat => ({ ...chat, status: 'archived' })),
		};
	const sessions = resources.add(new SessionsManagementService(provider));
	await sessions.initialize();
	const configuration = resources.add(
		new WorkbenchConfigurationService({
			source: JSON.stringify({ [ChatSessionArchiveActionWordingSettingId]: wording }),
		}),
	);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ISessionsManagementService, sessions);
	const opened: string[] = [];
	services.registerInstance(IChatSessionNavigationService, {
		revision: 0,
		getConversations: () => [],
		appendToActiveDraft: () => {},
		captureActiveDraft: async () => undefined,
		startVoiceConversation: async () => {
			throw new Error('Voice is outside this archive fixture');
		},
		getActiveConversation: () =>
			sessions.activeUntitledSession
				? undefined
				: sessions.active && {
						sessionId: sessions.active.session.sessionId,
						threadId: sessions.active.threadId,
					},
		openConversation: async (sessionId, threadId) => {
			opened.push(`${sessionId}/${threadId}`);
			await sessions.openThread(sessionId, threadId);
		},
	});
	const quickInput = resources.add(new TestQuickInputService({ container: dom.window.document.body, instantiationService: services }));
	services.registerInstance(IQuickInputService, quickInput);
	const commands = resources.add(new CommandService(services));
	return Object.assign(resources, {
		provider,
		sessions,
		services,
		commands,
		quickInput,
		opened,
		configuration,
		storage,
	});
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
				services.registerInstance(IDialogService, {
					confirm: async (options: { primaryButton: string }) => {
						labels.push(options.primaryButton);
						return { confirmed };
					},
				} as unknown as IDialogService);
				await commands.executeCommand('agentSession.archive');
				assert.deepEqual(provider.archived, []);
				confirmed = true;
				await commands.executeCommand('agentSession.archive');
				assert.deepEqual(provider.archived, ['first']);
				assert.equal(labels[0], locale === 'en' ? (wording === 'archive' ? 'Archive' : 'Mark as Done') : wording === 'archive' ? '归档' : '标记为完成');
				const draft = sessions.createUntitledSession('Preserved draft');
				const restore = commands.executeCommand('agentSession.restore');
				const picker = await pickerFor(quickInput);
				assert.equal(picker.items[0]?.label, locale === 'en' ? (wording === 'archive' ? 'Unarchive All' : 'Restore All') : wording === 'archive' ? '全部取消归档' : '全部恢复');
				picker.selectedItems = [picker.items[0] as IQuickPickItem];
				picker.accept();
				await restore;
				assert.deepEqual(provider.restored, ['first']);
				assert.equal(sessions.activeUntitledSession, draft);
				assert.deepEqual(current.opened, []);
				await commands.executeCommand('workbench.action.chat.archiveAllAgentSessions');
				assert.equal(sessions.untitledSessions[0], draft);
				assert.deepEqual(provider.archived, ['first', 'first', 'second']);
			} finally {
				resetNlsResolver();
			}
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
	assert.deepEqual(
		{ restored: current.provider.restored, opened: current.opened, status: current.sessions.sessions[0]?.status },
		{ restored: ['first'], opened: ['first/first-root'], status: 'active' },
	);
});

test('an archive confirmation retains its original Session target across navigation', async () => {
	using current = await fixture('done');
	const pending = new DeferredPromise<IConfirmationDialogResult>();
	const presented = new DeferredPromise<void>();
	current.services.registerInstance(IDialogService, {
		confirm: async () => {
			await presented.complete();
			return pending.p;
		},
	} as unknown as IDialogService);
	const archiving = current.commands.executeCommand('agentSession.archive', {
		sessionId: 'first',
		threadId: 'first-root',
	});
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
	current.provider.restore = async value => {
		await presented.complete();
		await pending.p;
		return restore(value);
	};
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

for (const locale of ['en', 'zh-CN']) {
	test(`archived deletion captures its target, requires confirmation and preserves other sessions and drafts (${locale})`, async () => {
		initializeTestLocalization(locale);
		try {
			using current = await fixture('archive', true);
			const draft = current.sessions.createUntitledSession('Unsent work');
			let confirmed = false;
			let calls = 0;
			current.services.registerInstance(IDialogService, {
				confirm: async (options: { primaryButton: string }) => {
					calls++;
					assert.equal(options.primaryButton, locale === 'zh-CN' ? '永久删除' : 'Delete permanently');
					return { confirmed };
				},
			} as unknown as IDialogService);
			await current.commands.executeCommand('agentSession.delete', 'first');
			assert.deepEqual(
				current.provider.items.map(session => session.sessionId),
				['first', 'second'],
			);
			confirmed = true;
			await current.commands.executeCommand('agentSession.delete', 'first');
			assert.deepEqual(
				current.sessions.sessions.map(session => session.sessionId),
				['second'],
			);
			assert.deepEqual(
				current.sessions.untitledSessions.map(session => session.untitledSessionId),
				[draft.untitledSessionId],
			);
			assert.equal(current.sessions.activeUntitledSession?.untitledSessionId, draft.untitledSessionId);
			assert.equal(calls, 2);
			confirmed = false;
			await current.commands.executeCommand('agentSession.delete', 'second');
			assert.equal(calls, 3);
			assert.deepEqual(current.provider.archived, [], 'cancelling delete must not archive an active chat');
			confirmed = true;
			await current.commands.executeCommand('agentSession.delete', 'second');
			assert.deepEqual(current.provider.archived, ['second']);
			assert.deepEqual(current.sessions.sessions, []);
			assert.equal(current.sessions.activeUntitledSession?.untitledSessionId, draft.untitledSessionId);
		} finally {
			resetNlsResolver();
		}
	});
}

test('closing the archived-deletion picker keeps the catalog and never opens a confirmation', async () => {
	using current = await fixture('archive', true);
	current.services.registerInstance(IDialogService, {
		confirm: async () => {
			throw new Error('Unexpected confirmation');
		},
	} as unknown as IDialogService);
	const deletion = current.commands.executeCommand('agentSession.delete');
	const picker = await pickerFor(current.quickInput);
	assert.deepEqual(
		picker.items.map(item => item.label),
		['first'],
	);
	picker.hide();
	await deletion;
	assert.deepEqual(
		current.sessions.sessions.map(session => session.sessionId),
		['first', 'second'],
	);
});

test('Session naming retains its captured Session across navigation and cancellation writes nothing', async () => {
	using current = await fixture('archive');
	const pending = new DeferredPromise<string | undefined>();
	let requested = false;
	current.quickInput.input = async options => {
		requested = true;
		assert.equal(options?.value, 'first');
		return pending.p;
	};
	const naming = current.commands.executeCommand('agentSession.rename', 'first');
	for (let attempt = 0; !requested && attempt < 100; attempt++) await new Promise<void>(resolve => setTimeout(resolve, 0));
	assert.equal(requested, true);
	current.sessions.selectThread('second', 'second-root');
	pending.complete('A deliberate name');
	await naming;
	assert.deepEqual(
		current.sessions.sessions.map(session => [session.sessionId, session.title]),
		[
			['first', 'A deliberate name'],
			['second', 'second'],
		],
	);
	assert.equal(current.sessions.active?.session.sessionId, 'second');
	current.quickInput.input = async () => undefined;
	await current.commands.executeCommand('agentSession.rename', 'first');
	assert.equal(current.sessions.sessions[0]?.title, 'A deliberate name');
});

test('sidebar destination commands act on the captured chat and reread the project revision', async () => {
	using current = await fixture('archive');
	const added: unknown[] = [];
	const moved: unknown[] = [];
	const project: Project = {
		id: 'project',
		name: 'Test project',
		revision: 9,
		archived: false,
		description: '',
		materials: [],
		sessionIds: [],
		sessionCount: 0,
	};
	current.services.registerInstance(IProjectService, {
		onDidChange: Event.None,
		list: async () => [{ ...project, revision: 1 }],
		read: async () => project,
		addSession: async (value, id) => {
			added.push([value.revision, id]);
			return { ...value, sessionIds: [id] };
		},
		create: async () => {
			throw new Error('Unexpected project creation');
		},
		update: async () => {
			throw new Error('Unexpected project edit');
		},
		archive: async () => {
			throw new Error('Unexpected project archive');
		},
		remove: async () => {
			throw new Error('Unexpected project deletion');
		},
	});
	current.services.registerInstance(ISessionGroupsService, {
		groups: [{ sectionId: 'group', name: 'Test group', sessionIds: [] }],
		onDidChange: Event.None,
		move: async (id, group) => {
			moved.push([id, group]);
		},
		create: async () => {
			throw new Error('Unexpected group creation');
		},
		rename: async () => {},
		delete: async () => {},
		reorder: async () => {},
	});
	const projectAction = current.commands.executeCommand('agentSession.addToProject', 'second');
	const projectPicker = await pickerFor(current.quickInput);
	projectPicker.activeItems = [projectPicker.items[0] as IQuickPickItem];
	projectPicker.accept();
	await projectAction;
	assert.deepEqual(added, [[9, 'second']]);
	const groupAction = current.commands.executeCommand('agentSession.moveToGroup', 'second');
	const groupPicker = await pickerFor(current.quickInput);
	groupPicker.activeItems = [groupPicker.items[2] as IQuickPickItem];
	groupPicker.accept();
	await groupAction;
	assert.deepEqual(moved, [['second', 'group']]);
	const cancelled = current.commands.executeCommand('agentSession.moveToGroup', 'first');
	(await pickerFor(current.quickInput)).hide();
	await cancelled;
	assert.deepEqual(moved, [['second', 'group']]);
});

for (const action of ['sessions.list.togglePin', 'agentSession.rename', 'agentSession.archive', 'agentSession.addToProject', 'agentSession.moveToGroup']) {
	test(`unsent item supports ${action} without submitting or changing another chat`, async () => {
		using current = await fixture('archive');
		const { sessions, commands, provider, storage, services, quickInput } = current;
		const draft = sessions.createUntitledSession('Unsent target');
		const other = sessions.createUntitledSession('Foreground draft');
		const text = {
			mode: 'plan' as const,
			text: 'Do not send this',
			contexts: [{ id: 'attachment', kind: 'file', name: 'note.txt', content: 'Synthetic attachment' }],
		};
		writeNewChatDraftState(storage, text, `untitled:${draft.untitledSessionId}`);
		services.registerInstance(IDialogService, {
			confirm: async () => ({ confirmed: true }),
		} as unknown as IDialogService);
		quickInput.input = async () => 'Named before sending';
		const project: Project = {
			id: 'project',
			name: 'Project',
			revision: 1,
			archived: false,
			description: '',
			materials: [],
			sessionIds: [],
			sessionCount: 0,
		};
		const linked: string[] = [];
		services.registerInstance(IProjectService, {
			onDidChange: Event.None,
			list: async () => [project],
			read: async () => project,
			addSession: async (value, id) => {
				linked.push(id);
				return value;
			},
			create: async () => {
				throw new Error('Unexpected project creation');
			},
			update: async () => {
				throw new Error('Unexpected project edit');
			},
			archive: async () => {
				throw new Error('Unexpected project archive');
			},
			remove: async () => {
				throw new Error('Unexpected project deletion');
			},
		});
		const moved: string[] = [];
		services.registerInstance(ISessionGroupsService, {
			groups: [{ sectionId: 'group', name: 'Group', sessionIds: [] }],
			onDidChange: Event.None,
			move: async id => {
				moved.push(id);
			},
			create: async () => {
				throw new Error('Unexpected group creation');
			},
			rename: async () => {},
			delete: async () => {},
			reorder: async () => {},
		});
		const target = { untitledSessionId: draft.untitledSessionId };
		const operation = commands.executeCommand(action, target);
		if (action === 'agentSession.addToProject' || action === 'agentSession.moveToGroup') {
			const picker = await pickerFor(quickInput);
			picker.activeItems = [picker.items[action === 'agentSession.addToProject' ? 0 : 2] as IQuickPickItem];
			picker.accept();
		}
		await operation;
		assert.deepEqual(provider.created, ['created-0']);
		assert.equal(sessions.activeUntitledSession?.untitledSessionId, other.untitledSessionId);
		assert.deepEqual(readNewChatDraftState(storage, 'created-0-root'), text);
		assert.equal(readNewChatDraftState(storage, `untitled:${draft.untitledSessionId}`), undefined);
		assert.equal(
			sessions.untitledSessions.some(value => value.untitledSessionId === draft.untitledSessionId),
			false,
		);
		if (action === 'sessions.list.togglePin') {
			assert.equal(storage.getBoolean('sessions.list.pinned.created-0', StorageScope.PROFILE), true);
			await commands.executeCommand(action, target);
			assert.equal(storage.getBoolean('sessions.list.pinned.created-0', StorageScope.PROFILE), false);
			assert.equal(provider.created.length, 1, 'A captured draft identity keeps resolving to the same chat');
		} else if (action === 'agentSession.rename') assert.equal(sessions.sessions.find(value => value.sessionId === 'created-0')?.title, 'Named before sending');
		else if (action === 'agentSession.archive') {
			assert.deepEqual(provider.archived, ['created-0']);
			await commands.executeCommand('agentSession.restore', 'created-0');
			assert.deepEqual(readNewChatDraftState(storage, 'created-0-root'), text);
		} else if (action === 'agentSession.addToProject') assert.deepEqual(linked, ['created-0']);
		else assert.deepEqual(moved, ['created-0']);
	});
}

test('cancelling unsent-item organization leaves its identity and draft untouched', async () => {
	using current = await fixture('archive');
	const draft = current.sessions.createUntitledSession('Unsent');
	const target = { untitledSessionId: draft.untitledSessionId };
	current.quickInput.input = async () => undefined;
	current.services.registerInstance(IDialogService, {
		confirm: async () => ({ confirmed: false }),
	} as unknown as IDialogService);
	await current.commands.executeCommand('agentSession.rename', target);
	await current.commands.executeCommand('agentSession.archive', target);
	current.services.registerInstance(ISessionGroupsService, { groups: [] } as unknown as ISessionGroupsService);
	const grouping = current.commands.executeCommand('agentSession.moveToGroup', target);
	(await pickerFor(current.quickInput)).hide();
	await grouping;
	assert.deepEqual(current.provider.created, []);
	assert.equal(current.sessions.activeUntitledSession, draft);
});
