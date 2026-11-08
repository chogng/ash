import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IChatService, type StartTurnOptions } from '../../../../../workbench/services/chat/common/chatService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionComparisonService, SessionComparisonService } from '../../../../services/sessions/browser/sessionComparisonService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { COMPARE_AGENTS_TOOLS_ENABLED_SETTING } from '../../../../services/sessions/common/sessionComparison.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ModelEvaluationToolContribution } from '../../browser/modelEvaluationTools.js';

suite('Model evaluation tools', () => {
	test('inherits caller permissions and persists exact model selections and partial launch outcomes', async () => {
		const dom = new JSDOM('', { url: 'https://ash.test' });
		using browser = { [Symbol.dispose]: () => dom.window.close() };
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'model-evaluation' });
		using services = new InstantiationService();
		services.registerInstance(IStorageService, storage);
		services.registerInstance(ILogService, new NullLoggerService());
		const comparisons = services.createInstance(SessionComparisonService);
		services.registerInstance(ISessionComparisonService, comparisons);
		let enabled = false;
		services.registerInstance(IConfigurationService, { getValue: (key: string) => key === COMPARE_AGENTS_TOOLS_ENABLED_SETTING && enabled } as unknown as IConfigurationService);
		const caller = { sessionId: 'source', threadId: 'source-thread', turnId: 'source-turn' };
		const source = { sessionId: caller.sessionId, status: 'active', chats: [{ threadId: caller.threadId, status: 'active' }] };
		const members: string[] = [];
		const group = { sectionId: 'comparison-1', kind: 'comparison', sessionIds: members };
		services.registerInstance(ISessionGroupsService, {
			groups: [group], create: async () => group, move: async (id: string) => { members.push(id); },
		} as unknown as ISessionGroupsService);
		let next = 0;
		services.registerInstance(ISessionsManagementService, {
			sessions: [source],
			createUntitledSession(_title: string, workspace: unknown, providerId: string, activate: boolean) {
				assert.deepEqual(workspace, { type: 'current' });
				assert.equal(providerId, LOCAL_AGENT_HOST_PROVIDER_ID);
				assert.equal(activate, false);
				return { untitledSessionId: `attempt-${++next}` };
			},
			setUntitledSessionAgent() { },
			materializeUntitledSession: async (id: string) => ({ session: { sessionId: id }, threadId: `${id}-thread` }),
			promoteUntitledSession() { },
		} as unknown as ISessionsManagementService);
		const role = { sourceId: 'directory', name: 'Reviewer', description: 'Reviews a patch' };
		services.registerInstance(ISessionsProvidersService, { getProvider: () => ({ listAgents: async () => [role] }) } as unknown as ISessionsProvidersService);
		const models = ['one', 'two'].map(provider => ({
			model: { provider, model: 'same' }, displayName: 'Shared name', supportedReasoningEfforts: [{ effort: 'high' }],
		}));
		services.registerInstance(ISessionProviderScopeService, {
			getProviderScope: () => ({ assertCurrent() { }, services: { models: { listModels: async () => models } } }),
		} as unknown as ISessionProviderScopeService);
		const submissions: StartTurnOptions[] = [];
		services.registerInstance(IChatService, {
			async readThread(id: string) {
				const submission = submissions.find(request => request.sessionId === id);
				const turns = id === caller.sessionId ? [{ turnId: caller.turnId, approvalMode: 'manual', items: [] }]
					: submission ? [{ turnId: 'attempt-turn', status: 'completed', items: [{ type: 'userMessage', text: submission.text }] }] : [];
				return { thread: { sequence: 1, turns } };
			},
			async startTurn(request: StartTurnOptions) {
				if (request.sessionId === 'attempt-3') throw new Error('Fixture launch failure');
				submissions.push(request);
			},
		} as unknown as IChatService);

		const tools = services.createInstance(ModelEvaluationToolContribution);
		const signal = new AbortController().signal;
		const discover = { type: 'getComparisonModels', workspaceMode: 'folderless' } as const;
		await assert.rejects(tools.execute(caller, discover, signal), /disabled in Settings/);
		enabled = true;
		assert.deepEqual(await tools.execute(caller, discover, signal), {
			workspaceMode: 'folderless',
			agents: [{ source_id: 'directory', agent: 'Reviewer' }],
			models: models.map(({ model, displayName }) => ({ model, label: displayName, reasoning_efforts: ['high'] })),
			truncated: false,
		});
		const create = {
			type: 'createModelComparison', workspaceMode: 'folderless', prompt: 'Review the patch', judge: null, synthesizer: null,
			attempts: [...models, models[0]].map(({ model }) => ({ sourceId: role.sourceId, agent: role.name, model, reasoningEffort: 'high' as const })),
		} as const;
		const launched = await tools.execute(caller, create, signal) as { comparisonId: string; attempts: { status: string; }[]; };
		assert.equal(launched.comparisonId, group.sectionId);
		assert.deepEqual(launched.attempts.map(attempt => attempt.status), ['launched', 'launched', 'launchFailed']);
		assert.deepEqual(submissions.map(({ model, text, approvalMode, reasoningEffort, mode }) => ({ model, text, approvalMode, reasoningEffort, mode })),
			models.map(({ model }) => ({ model, text: create.prompt, approvalMode: 'manual', reasoningEffort: 'high', mode: 'ask' })));
		assert.deepEqual(members, ['attempt-1', 'attempt-2']);
		assert.deepEqual(await tools.execute(caller, {
			type: 'listModelComparisons', includeArchived: false, workspace: null, comparisonIds: [], cursor: null,
		}, signal), {
			comparisons: [{ comparisonId: group.sectionId, workspace: null, workspaceMode: 'folderless', scenario: create.prompt, attemptCount: 3, archived: false }],
			nextCursor: undefined,
		});
		const result = await tools.execute(caller, { type: 'readModelComparison', comparisonId: group.sectionId }, signal) as { attempts: { status: string; }[]; task: string; };
		assert.equal(result.task, create.prompt);
		assert.deepEqual(result.attempts.map(attempt => attempt.status), ['completed', 'completed', 'launchFailed']);
	});
});
