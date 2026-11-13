import '../../browser/agentHostDelegation.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, QuickInputHideReason, type IQuickPick, type IQuickPickDidAcceptEvent, type IQuickInputHideEvent, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, type StartTurnOptions } from '../../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import type { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { ISessionComparisonService, SessionComparisonService } from '../../../../services/sessions/browser/sessionComparisonService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

test('Compare Agents sends identical tasks in parallel from separate worktrees and supports Judge retry and isolated synthesis', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	using browser = { [Symbol.dispose]: () => dom.window.close() };
	using aria = setARIAContainer(dom.window.document.body);
	using services = new InstantiationService();
	using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'comparison-test' });
	using contexts = new ContextKeyService();
	contexts.setContext('sessions.workspaceMode', 'code');
	services.registerInstance(IContextKeyService, contexts);
	services.registerInstance(IStorageService, storage);
	const comparisons = services.createInstance(SessionComparisonService);
	services.registerInstance(ISessionComparisonService, comparisons);
	const source = { sessionId: 'source', providerId: 'host', status: 'active', workspace: { authorityId: 'local', root: '/project' } } as ISession;
	const workspace = { type: 'local', root: '/project' } as const;
	const model = { provider: 'fixture', model: 'participant-model' };
	const targets = ['Alpha', 'Beta'];
	const failures: unknown[] = [];
	let revision = 0;
	const provider = { id: 'host', listAgents: async () => targets.map(name => ({ name, sourceId: 'directory', description: '' })) };
	const opened = ['source'];
	const branches = new Map<string, string>();
	const submissions: StartTurnOptions[] = [];
	const sent = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	let selection: SessionsViewSelection = { kind: 'session', active: { session: source, threadId: 'source-thread' } };
	services.registerInstance(ISessionsService, {
		get activeSelection() { return selection; },
		get navigationRevision() { return revision; },
		async openThread(sessionId: string, threadId: string, options: { sideBySide: boolean; }) {
			assert.equal(options.sideBySide, true);
			revision++;
			if (sessionId === 'Alpha') throw new Error('Pane unavailable');
			opened.push(sessionId);
			selection = { kind: 'session', active: { session: { ...source, sessionId }, threadId } };
		},
	} as unknown as ISessionsService);
	services.registerInstance(ISessionsProvidersService, { getProvider: () => provider } as unknown as ISessionsProvidersService);
	services.registerInstance(IConfigurationService, { getValue: () => false } as unknown as IConfigurationService);
	services.registerInstance(ILogService, new NullLoggerService());
	services.registerInstance(INotificationService, { error: (error: unknown) => failures.push(error), warn: assert.fail } as unknown as INotificationService);
	const grouped: string[] = [];
	let evaluation = false;
	let judgeCount = 0;
	let judgeReply = 'invalid verdict';
	const group = { sectionId: 'comparison', name: 'Compare · Implement the fix', kind: 'comparison', sessionIds: grouped };
	services.registerInstance(ISessionGroupsService, {
		groups: [group],
		async create(name: string, _signal: AbortSignal | undefined, kind: string) {
			assert.equal(kind, 'comparison');
			assert.equal(name, 'Compare · Implement the fix');
			return group;
		},
		async move(id: string, section: string) {
			assert.equal(section, 'comparison');
			grouped.push(id);
		},
	} as unknown as ISessionGroupsService);
	services.registerInstance(ISessionsManagementService, {
		sessions: [source],
		createUntitledSession() { return { untitledSessionId: `judge-${++judgeCount}` }; },
		setUntitledSessionAgent() { },
		async materializeUntitledSession(id: string) { return { session: { sessionId: id }, threadId: `${id}-thread` }; },
		promoteUntitledSession() { },
	} as unknown as ISessionsManagementService);
	services.registerInstance(ISessionProviderScopeService, {
		getScope(id: string) {
			assert.equal(id, source.sessionId);
			return {
				assertCurrent() { },
				services: { models: { listModels: async () => [{ model, displayName: 'Participant model', supportedReasoningEfforts: [{ effort: 'high' }] }] } },
				thread: {
					async fork(options: Parameters<IAgentThreadService['fork']>[0]) {
						assert.equal(options.sessionId, source.sessionId);
						assert.equal(options.threadId, 'source-thread');
						assert.equal(options.target, 'session');
						assert.ok(options.comparison);
						assert.equal(options.comparison.sourceSequence, 7);
						const name = options.comparison.agent.name;
						if (options.title.startsWith('Synthesis')) {
							assert.match(options.comparison.branchName, /^ash\/compare-synthesis-/);
							return { sessionId: 'synthesis', threadId: 'synthesis-thread' };
						}
						assert.equal(options.title, `Attempt ${targets.indexOf(name) + 1} · ${name}`);
						branches.set(name, options.comparison.branchName);
						return { sessionId: name, threadId: `${name}-thread` };
					}
				}
			};
		},
	} as unknown as ISessionProviderScopeService);
	services.registerInstance(IChatService, {
		async readThread(id: string) {
			const submission = submissions.find(candidate => candidate.sessionId === id);
			if (evaluation && submission) {
				return {
					directory: workspace, thread: {
						sequence: 8, turns: [{
							turnId: 'comparison-turn', status: 'completed', items: [
								{ type: 'userMessage', text: submission.text },
								{ type: 'agentMessage', text: id.startsWith('judge-') ? judgeReply : `Result from ${id}` },
								{ type: 'toolCall', name: 'shell-command', toolCallId: 'check', argumentsJson: '{"program":"test"}' },
								{ type: 'toolResult', toolCallId: 'check', text: 'Fixture check completed', isError: false },
							],
						}]
					}
				};
			}
			return { directory: workspace, thread: { sequence: 7, turns: id === 'source' ? [{ items: [{ type: 'userMessage', text: 'Prior question' }, { type: 'agentMessage', text: 'Prior answer' }] }] : [] } };
		},
		async listTurnChanges() {
			return [{ turnId: 'comparison-turn', changeSetId: 'changes', statistics: { files: 1, additions: 3, deletions: 1 } }];
		},
		async readTurnChange(id: string) {
			return { files: [{ path: `src/${id}.ts`, kind: 'modified' }] };
		},
		async startTurn(options: StartTurnOptions) {
			submissions.push(options);
			if (submissions.length === 2) await sent.complete();
			await release.p;
		},
	} as unknown as IChatService);
	services.registerInstance(IQuickInputService, {
		createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
			const accept = new Emitter<IQuickPickDidAcceptEvent>();
			const hide = new Emitter<IQuickInputHideEvent>();
			const picker = {
				items: [] as readonly T[],
				selectedItems: [] as readonly T[],
				canSelectMany: false,
				onDidAccept: accept.event,
				onDidHide: hide.event,
				show() {
					this.selectedItems = this.canSelectMany ? this.items : evaluation
						? [this.items.find(item => item.label === 'Synthesize Recommended' || item.label === 'Beta') ?? this.items[0]!]
						: [this.items[1]!];
					accept.fire({ inBackground: false });
				},
				hide() { hide.fire({ reason: QuickInputHideReason.Other }); },
				dispose() { accept.dispose(); hide.dispose(); },
				[Symbol.dispose]() { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
		input: async () => evaluation ? 'Preserve the public API.' : 'Implement the fix',
	} as unknown as IQuickInputService);

	const command = CommandsRegistry.getCommand('sessions.chat.compareAgents')!;
	const run = services.invokeFunction(command);
	try {
		await Promise.race([sent.p, Promise.resolve(run).then(() => assert.fail('Comparison finished before submitting both agents'))]);
		assert.equal(new Set(branches.values()).size, 2);
		assert.deepEqual(submissions.map(({ sessionId }) => sessionId).sort(), targets);
		for (const submission of submissions) {
			assert.equal(submission.text, 'Implement the fix');
			assert.equal(submission.mode, 'agent');
			assert.equal(submission.expectedSequence, 7);
			assert.equal(submission.commandInterpretation, 'literal');
			assert.equal(submission.contexts, undefined);
			assert.deepEqual(submission.model, model);
			assert.equal(submission.reasoningEffort, 'high');
		}
	} finally {
		await release.complete();
		await run;
	}
	assert.deepEqual(opened, ['source', 'Beta']);
	assert.deepEqual(grouped, targets);
	assert.deepEqual(failures, ['Alpha: Error: Pane unavailable']);
	evaluation = true;
	const evaluate = CommandsRegistry.getCommand('sessions.chat.evaluateComparison')!;
	await services.invokeFunction(evaluate);
	assert.deepEqual(failures, ['Alpha: Error: Pane unavailable']);
	assert.equal(comparisons.get(group.sectionId)?.judge?.sessionId, 'judge-1');
	assert.equal(submissions.at(-1)?.mode, 'ask');
	assert.deepEqual(submissions.at(-1)?.model, model);
	assert.match(submissions.at(-1)?.contexts?.[0]?.content ?? '', /Result from Alpha/);
	assert.match(submissions.at(-1)?.contexts?.[0]?.content ?? '', /src\/Alpha\.ts/);
	const manifest = JSON.parse(submissions.at(-1)?.contexts?.[0]?.content ?? 'null');
	assert.equal(manifest.schema, 'ash.attempt-comparison.v1');
	assert.deepEqual(manifest.evidence[0].verification, {
		actions: [{ source: 'recordedToolResult', tool: 'shell-command', arguments: '{"program":"test"}', result: 'Fixture check completed', toolReportedError: false }],
		truncated: false,
	});
	await services.invokeFunction(evaluate);
	assert.equal(comparisons.get(group.sectionId)?.judge?.sessionId, 'judge-2');
	assert.deepEqual(submissions.at(-1)?.model, model);

	judgeReply = JSON.stringify({ winner: 2, comparison: 'More complete', validation: 'Reported tests', quality: 'Clearer', solution: 'Prefer Beta' });
	await services.invokeFunction(evaluate);
	const saved = services.createInstance(SessionComparisonService).get(group.sectionId);
	assert.equal(saved?.verdict?.winner, 2);
	assert.equal(saved?.synthesis?.sessionId, 'synthesis');
	assert.equal(submissions.at(-1)?.mode, 'agent');
	assert.deepEqual(submissions.at(-1)?.model, model);
	assert.match(submissions.at(-1)?.text ?? '', /Preserve the public API/);
	assert.deepEqual(grouped, ['Alpha', 'Beta', 'judge-1', 'judge-2', 'synthesis']);
});
