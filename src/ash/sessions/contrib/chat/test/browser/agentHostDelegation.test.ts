import '../../browser/agentHostDelegation.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, QuickInputHideReason, type IQuickPick, type IQuickPickDidAcceptEvent, type IQuickInputHideEvent, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatService, type StartTurnOptions } from '../../../../../workbench/services/chat/common/chatService.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import type { IAgentThreadService } from '../../../../../platform/agentHost/common/agentService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsService, type SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';

test('Compare Agents sends identical tasks in parallel from separate worktrees and opens the next result when the first pane fails', async () => {
	const dom = new JSDOM();
	using browser = { [Symbol.dispose]: () => dom.window.close() };
	using aria = setARIAContainer(dom.window.document.body);
	using services = new InstantiationService();
	const source = { sessionId: 'source', providerId: 'host', status: 'active', workspace: { authorityId: 'local', root: '/project' } } as ISession;
	const workspace = { type: 'local', root: '/project' } as const;
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
	services.registerInstance(ISessionsManagementService, {} as ISessionsManagementService);
	services.registerInstance(ISessionProviderScopeService, {
		getScope(id: string) {
			assert.equal(id, source.sessionId);
			return {
				thread: {
					async fork(options: Parameters<IAgentThreadService['fork']>[0]) {
						assert.equal(options.sessionId, source.sessionId);
						assert.equal(options.threadId, 'source-thread');
						assert.equal(options.target, 'session');
						assert.ok(options.comparison);
						assert.equal(options.comparison.sourceSequence, 7);
						assert.equal(options.comparison.agent.name, options.title);
						branches.set(options.title, options.comparison.branchName);
						return { sessionId: options.title, threadId: `${options.title}-thread` };
					}
				}
			};
		},
	} as unknown as ISessionProviderScopeService);
	services.registerInstance(IChatService, {
		async readThread(id: string) {
			return { directory: workspace, thread: { sequence: 7, turns: id === 'source' ? [{ items: [{ type: 'userMessage', text: 'Prior question' }, { type: 'agentMessage', text: 'Prior answer' }] }] : [] } };
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
					this.selectedItems = this.canSelectMany ? this.items : this.items.slice(1);
					accept.fire({ inBackground: false });
				},
				hide() { hide.fire({ reason: QuickInputHideReason.Other }); },
				dispose() { accept.dispose(); hide.dispose(); },
				[Symbol.dispose]() { this.dispose(); },
			};
			return picker as unknown as IQuickPick<T>;
		},
		input: async () => 'Implement the fix',
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
		}
	} finally {
		await release.complete();
		await run;
	}
	assert.deepEqual(opened, ['source', 'Beta']);
	assert.deepEqual(failures, ['Alpha: Error: Pane unavailable']);
});
