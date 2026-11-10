import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { TestConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import {
	IChatService,
	type StartTurnOptions,
	type ThreadRead,
} from '../../../../../workbench/services/chat/common/chatService.js';
import { ISessionPrimaryProviderServices, type SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { SessionsManagementService } from '../../../../services/sessions/browser/sessionsManagementService.js';
import { SessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import type { IActiveSessionThread } from '../../../../services/sessions/common/session.js';
import { ProjectChatModel } from '../../browser/projectChatModel.js';

class ProjectChatFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly revealed = new DeferredPromise<void>();
	readonly reading = new DeferredPromise<void>();
	readonly calls: string[] = [];
	readonly turns: StartTurnOptions[] = [];
	readonly creationIds: (string | undefined)[] = [];
	readonly preferredModel = { provider: 'fixture', model: 'chat-fixture' };
	project: Project = {
		id: 'project',
		name: 'Project',
		description: '',
		revision: 1,
		archived: false,
		materials: [],
		sessionIds: [],
		createdAtMs: 1,
		updatedAtMs: 1,
		sessionCount: 0,
	};
	linkFailure: Error | undefined;
	sendFailure: Error | undefined;
	pendingRead: DeferredPromise<Project> | undefined;
	readonly model: ProjectChatModel;

	constructor() {
		super();
		const active: IActiveSessionThread = {
			session: {
				sessionId: 'session', kind: 'chat' as const,
				title: 'New Chat',
				status: 'active',
				nextApprovalMode: 'manual',
				chats: [{ threadId: 'thread', origin: { type: 'root' }, status: 'active' }],
			},
			threadId: 'thread',
		};
		const snapshot: ThreadRead = {
			thread: {
				sessionId: 'session',
				threadId: 'thread',
				agentId: 'agent',
				origin: { type: 'root' },
				advisor: { type: 'default' },
				title: 'New Chat',
				status: 'active',
				sequence: 1,
				turns: [],
				usage: {
					modelInvocations: 0,
					inputTokens: { reported: 0, complete: true },
					outputTokens: { reported: 0, complete: true },
					cachedInputTokens: { reported: 0, complete: true },
					cacheWriteInputTokens: { reported: 0, complete: true },
					reasoningTokens: { reported: 0, complete: true },
				},
			},
			transcript: {
				sessionId: 'session',
				threadId: 'thread',
				durableSequence: 1,
				revision: 1,
				entries: [],
			},
		};
		const chat = {
			onDidUpdateThread: Event.None,
			onDidUpdateThreadTranscript: Event.None,
			onDidUpdateGoal: Event.None,
			onDidChangeInteractionOffer: Event.None,
			onDidBecomeReady: Event.None,
			onDidChangeQueue: Event.None,
			onDidUpdateTurnChanges: Event.None,
			getInteractionOffer: () => undefined,
			listSlashCommands: async () => [],
			readAdvisorDefault: async () => null,
			subscribeThread: async () => ({ ...snapshot, updates: [] }),
			unsubscribeThread: async () => { },
			readThread: async () => snapshot,
			readContextUsage: async () => ({ estimatedTokens: 0, categories: [] }),
			readQueue: async () => [],
			listTurnChanges: async () => [],
			readThreadChanges: async () => ({
				sequence: 1,
				revision: '1',
				statistics: { files: 0, additions: 0, deletions: 0 },
				repositories: [],
				warnings: [],
			}),
			startTurn: async (options: StartTurnOptions) => {
				this.calls.push('send');
				if (this.sendFailure) throw this.sendFailure;
				this.turns.push(options);
			},
		} as unknown as IChatService;
		const prompts = {
			onDidChangeSkills: Event.None,
			findAgentSkills: async () => [],
		} as unknown as IPromptsService;
		const models = {
			onDidChangeModels: Event.None,
			listModelCatalog: async () => [{ model: this.preferredModel, displayName: 'Chat fixture', longContext: null }],
			isModelVisible: () => true,
		} as unknown as ILanguageModelsService;
		const execution: IAgentExecutionSettingsService = {
			onDidChange: Event.None,
			read: async () => ({
				revision: 1,
				settings: {
					approvalMode: 'manual',
					commandFileAccess: 'directoryWrite',
					commandNetworkAccess: 'denied',
				},
			}),
			configure: async () => { },
		};
		this.services.registerInstance(ISessionPrimaryProviderServices, { chat, prompts, models, execution } as SessionProviderServices);
		this.services.registerInstance(IContextKeyService, this._register(new ContextKeyService()));
		this.services.registerInstance(IStorageService, { get: () => undefined } as unknown as IStorageService);
		this.services.registerInstance(IConfigurationService, this._register(new TestConfigurationService()));
		const projects = {
			read: async (id: string, scope?: string) => {
				assert.equal(id, this.project.id);
				assert.equal(scope, 'chat');
				if (!this.reading.isSettled) await this.reading.complete();
				return this.pendingRead ? this.pendingRead.p : this.project;
			},
			addSession: async (project: Project, sessionId: string) => {
				this.calls.push(`link:${project.revision}`);
				if (this.linkFailure) throw this.linkFailure;
				this.project = {
					...project,
					revision: project.revision + 1,
					sessionIds: [sessionId],
					sessionCount: 1,
				};
				return this.project;
			},
		} as unknown as IProjectService;
		const providers = this._register(new SessionsProvidersService());
		const provider: Partial<ISessionsProvider> = {
			id: 'local', order: 0, onDidChangeCatalog: Event.None, onDidChangeSession: Event.None,
			currentWorkspace: () => ({ type: 'current' }),
			create: async (_title, workspace, _agent, creationId, options) => {
				assert.deepEqual(workspace, { type: 'current' });
				assert.equal(options?.kind, 'chat');
				this.creationIds.push(creationId);
				if (this.creationIds.length === 1) this.calls.push('create');
				return active;
			},
		};
		this._register(providers.registerProvider(provider as ISessionsProvider));
		const management = this._register(new SessionsManagementService('local', providers, undefined, undefined, undefined, projects));
		this.services.registerInstance(ISessionsManagementService, management);
		const draft = management.createUntitledSession(undefined, { type: 'current' }, 'local', false, undefined, { kind: 'chat', projectId: this.project.id });
		management.setUntitledSessionModel(draft.untitledSessionId, this.preferredModel);
		this.services.registerInstance(ISessionsService, {} as ISessionsService);
		this.services.registerInstance(ICommandService, {} as ICommandService);
		this.services.registerInstance(INotificationService, {
			error: (error: Error) => { throw error; },
		} as unknown as INotificationService);
		this.services.registerInstance(IOpenerService, {
			open: async () => {
				this.calls.push('open');
				await this.revealed.complete();
				return true;
			},
		} as unknown as IOpenerService);
		this.model = this._register(this.services.createInstance(ProjectChatModel, management.untitledSessions[0]!));
		this._register(
			toDisposable(() => {
				if (this.pendingRead && !this.pendingRead.isSettled) void this.pendingRead.complete(this.project);
			}),
		);
	}
}

suite('Project chat submission', () => {
	for (const text of ['/advisor Question', '/advisor off', '/compact', '/config', '/init', '/develop Request', '/team Request', '/unknown']) {
		test(`project sends ${text} as a literal first message with membership and navigation`, async () => {
			using fixture = new ProjectChatFixture();
			await fixture.model.send(text, 'agent');
			await fixture.revealed.p;
			assert.deepEqual(fixture.calls, ['create', 'link:1', 'send', 'open']);
			assert.equal(fixture.turns[0]!.text, text);
			assert.equal(fixture.turns[0]!.commandInterpretation, 'literal');
		});
	}

	test('empty input does not create a conversation or link a project', async () => {
		using fixture = new ProjectChatFixture();
		await fixture.model.send('   ', 'agent');
		assert.deepEqual(fixture.calls, []);
		assert.equal(fixture.model.submitted, false);
	});

	test('links the current project revision before sending, then reveals the saved conversation', async () => {
		using fixture = new ProjectChatFixture();
		fixture.project = { ...fixture.project, revision: 8 };
		await fixture.model.send('First project task', 'ask', undefined, [{ name: 'Notes', content: 'Attached notes' }]);
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, ['create', 'link:8', 'send', 'open']);
		assert.equal(fixture.turns[0].text, 'First project task');
		assert.equal(fixture.turns[0].mode, 'agent');
		assert.deepEqual(fixture.turns[0].model, fixture.preferredModel);
		assert.deepEqual(fixture.turns[0].contexts, [{ name: 'Notes', content: 'Attached notes' }]);
		assert.equal(fixture.model.submitted, true);
	});

	test('association failure sends nothing and retry reuses the same durable conversation', async () => {
		using fixture = new ProjectChatFixture();
		fixture.linkFailure = new Error('Revision conflict');
		await assert.rejects(fixture.model.send('Keep my draft', 'agent'), /Revision conflict/);
		assert.deepEqual(fixture.calls, ['create', 'link:1']);
		assert.equal(fixture.model.submitted, false);
		fixture.linkFailure = undefined;
		fixture.project = { ...fixture.project, revision: 2 };
		await fixture.model.send('Keep my draft', 'agent');
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, [
			'create',
			'link:1',
			'link:2',
			'send',
			'open',
		]);
		assert.equal(fixture.creationIds.length, 2);
		assert.ok(fixture.creationIds[0]);
		assert.equal(fixture.creationIds[0], fixture.creationIds[1]);
	});

	test('a failed send keeps project membership and retries without creating or linking again', async () => {
		using fixture = new ProjectChatFixture();
		fixture.sendFailure = new Error('Request unavailable');
		await assert.rejects(fixture.model.send('Retry this task', 'agent'), /Request unavailable/);
		assert.equal(fixture.model.submitted, false);
		fixture.sendFailure = undefined;
		await fixture.model.send('Retry this task', 'agent');
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, ['create', 'link:1', 'send', 'send', 'open']);
	});

	test('voice prepares a project-owned conversation before any task is sent', async () => {
		using fixture = new ProjectChatFixture();
		const conversation = await fixture.model.prepareConversation();
		assert.deepEqual(conversation, { sessionId: 'session', threadId: 'thread' });
		assert.deepEqual(fixture.calls, ['create', 'link:1']);
		assert.equal(fixture.model.submitted, false);
		await fixture.model.send('Voice task', 'agent', undefined, undefined, { source: conversation });
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, ['create', 'link:1', 'send', 'open']);
	});

	test('navigation during project lookup cancels the request before linking or sending', async () => {
		using fixture = new ProjectChatFixture();
		fixture.pendingRead = new DeferredPromise<Project>();
		const controller = new AbortController();
		const pending = fixture.model.send('Cancelled task', 'agent', undefined, undefined, { signal: controller.signal });
		await fixture.reading.p;
		controller.abort();
		await fixture.pendingRead.complete(fixture.project);
		await assert.rejects(pending);
		assert.deepEqual(fixture.calls, []);
		assert.deepEqual(fixture.turns, []);
		assert.equal(fixture.model.submitted, false);
	});
});
