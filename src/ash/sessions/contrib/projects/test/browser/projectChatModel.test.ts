import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { IAgentExecutionSettingsService } from '../../../../../platform/agentHost/common/agentExecutionSettingsService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProjectService, type Project } from '../../../../../platform/projects/common/projectService.js';
import { TestConfigurationService } from '../../../../../workbench/services/configuration/test/common/testServices.js';
import { ILanguageModelsService } from '../../../../../workbench/contrib/chat/common/languageModels.js';
import { IPromptsService } from '../../../../../workbench/contrib/chat/common/promptSyntax/service/promptsService.js';
import {
	IChatService,
	type StartTurnOptions,
	type ThreadRead,
} from '../../../../../workbench/services/chat/common/chatService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { IActiveSessionThread, IUntitledChatSession } from '../../../../services/sessions/common/session.js';
import { ProjectChatModel } from '../../browser/projectChatModel.js';
import { ILanguageModelsConfigurationService } from '../../../cowork/common/languageModelsConfiguration.js';

class ProjectChatFixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly draft: IUntitledChatSession = {
		untitledSessionId: 'draft',
		title: 'New Chat',
		workspace: { type: 'current' },
		model: undefined,
		agent: undefined,
	};
	readonly revealed = new DeferredPromise<void>();
	readonly reading = new DeferredPromise<void>();
	readonly calls: string[] = [];
	readonly turns: StartTurnOptions[] = [];
	readonly preferredModel = { provider: 'fixture', model: 'cowork-default' };
	project: Project = {
		id: 'project',
		name: 'Project',
		description: '',
		revision: 1,
		archived: false,
		materials: [],
		sessionIds: [],
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
				sessionId: 'session',
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
		this.services.registerInstance(IChatService, {
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
		} as unknown as IChatService);
		this.services.registerInstance(ISessionsManagementService, {
			untitledSessions: [this.draft],
			materializedSessions: observableValue('materialized projects', new Map()),
			setUntitledSessionDefaultModel() { },
			materializeUntitledSession: async () => {
				this.calls.push('create');
				return active;
			},
			promoteUntitledSession() { },
		} as unknown as ISessionsManagementService);
		this.services.registerInstance(IPromptsService, {
			onDidChangeSkills: Event.None,
			findAgentSkills: async () => [],
		} as unknown as IPromptsService);
		this.services.registerInstance(ILanguageModelsService, {
			onDidChangeModels: Event.None,
			listModels: async () => [
				{
					model: this.preferredModel,
					displayName: 'Cowork default',
					longContext: null,
				},
			],
			listModelCatalog: async () => [],
			getDefaultNewChatModel: () => undefined,
			readModelDefaults: async () => ({
				revision: 1,
				model: null,
				reasoningEffort: null,
			}),
		} as unknown as ILanguageModelsService);
		this.services.registerInstance(ILanguageModelsConfigurationService, {
			onDidChangeModels: Event.None,
			getDefaultNewChatModel: () => this.preferredModel,
			rememberSelectedModel() { },
			isModelVisible: () => true,
			setModelVisible: async () => { },
		});
		this.services.registerInstance(IAgentExecutionSettingsService, {
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
		});
		this.services.registerInstance(IConfigurationService, this._register(new TestConfigurationService()));
		this.services.registerInstance(IProjectService, {
			read: async () => {
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
		} as unknown as IProjectService);
		this.services.registerInstance(ISessionsService, {
			openSession: (session: string, thread: string) => this.calls.push(`open:${session}/${thread}`),
		} as unknown as ISessionsService);
		this.services.registerInstance(ICommandService, {
			executeCommand: async (command: string) => {
				this.calls.push(command);
				await this.revealed.complete();
			},
		} as unknown as ICommandService);
		this.services.registerInstance(INotificationService, {
			error: (error: Error) => {
				throw error;
			},
		} as unknown as INotificationService);
		this.model = this._register(this.services.createInstance(ProjectChatModel, 'project', this.draft));
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
			assert.equal('executeServerCommand' in fixture.model, false);
			await fixture.model.send(text);
			await fixture.revealed.p;
			assert.deepEqual(fixture.calls, ['create', 'link:1', 'send', 'open:session/thread', 'sessions.open.chat']);
			assert.equal(fixture.turns[0]!.text, text);
			assert.equal(fixture.turns[0]!.commandInterpretation, 'literal');
		});
	}

	test('empty input does not create a conversation or link a project', async () => {
		using fixture = new ProjectChatFixture();
		await fixture.model.send('   ');
		assert.deepEqual(fixture.calls, []);
		assert.equal(fixture.model.submitted, false);
	});

	test('links the current project revision before sending, then reveals the saved conversation', async () => {
		using fixture = new ProjectChatFixture();
		fixture.project = { ...fixture.project, revision: 8 };
		await fixture.model.send('First project task', 'ask', undefined, [{ name: 'Notes', content: 'Attached notes' }]);
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, ['create', 'link:8', 'send', 'open:session/thread', 'sessions.open.chat']);
		assert.equal(fixture.turns[0].text, 'First project task');
		assert.equal(fixture.turns[0].mode, 'ask');
		assert.deepEqual(fixture.turns[0].model, fixture.preferredModel);
		assert.deepEqual(fixture.turns[0].contexts, [{ name: 'Notes', content: 'Attached notes' }]);
		assert.equal(fixture.model.submitted, true);
	});

	test('association failure sends nothing and retry reuses the same durable conversation', async () => {
		using fixture = new ProjectChatFixture();
		fixture.linkFailure = new Error('Revision conflict');
		await assert.rejects(fixture.model.send('Keep my draft'), /Revision conflict/);
		assert.deepEqual(fixture.calls, ['create', 'link:1']);
		assert.equal(fixture.model.submitted, false);
		fixture.linkFailure = undefined;
		fixture.project = { ...fixture.project, revision: 2 };
		await fixture.model.send('Keep my draft');
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, [
			'create',
			'link:1',
			'link:2',
			'send',
			'open:session/thread',
			'sessions.open.chat',
		]);
	});

	test('a failed send keeps project membership and retries without creating or linking again', async () => {
		using fixture = new ProjectChatFixture();
		fixture.sendFailure = new Error('Request unavailable');
		await assert.rejects(fixture.model.send('Retry this task'), /Request unavailable/);
		assert.equal(fixture.model.submitted, false);
		fixture.sendFailure = undefined;
		await fixture.model.send('Retry this task');
		await fixture.revealed.p;
		assert.deepEqual(fixture.calls, ['create', 'link:1', 'send', 'send', 'open:session/thread', 'sessions.open.chat']);
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
		assert.deepEqual(fixture.turns, []);
		assert.equal(fixture.model.submitted, false);
	});
});
