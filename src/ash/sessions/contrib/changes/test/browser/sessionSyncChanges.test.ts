import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService, CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { SessionSyncChangesActionViewItem } from '../../browser/sessionSyncChanges.js';

suite('Session Git actions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const interrupt of ['none', 'selection', 'branch', 'failure'] as const) {
		test(`sync targets the session repository and stops correctly after ${interrupt}`, async () => {
			using services = new InstantiationService();
			using changed = new Emitter<void>();
			using contexts = CommandsRegistry.register('git.getRepositoryContexts', () => undefined);
			using pull = CommandsRegistry.register('git.pull', () => undefined);
			using push = CommandsRegistry.register('git.push', () => undefined);
			let sessionId = 'session';
			let branch = 'feature';
			const pending = new DeferredPromise<void>();
			const started = new DeferredPromise<void>();
			const calls: unknown[] = [];
			const errors: string[] = [];
			services.registerInstance(ISessionsService, {
				onDidChange: changed.event,
				get activeSelection() {
					return {
						kind: 'session',
						active: {
							session: { sessionId, workspace: { authorityId: 'local', root: '/session-worktree' } },
							threadId: 'thread',
						},
					};
				},
			} as unknown as ISessionsService);
			services.registerInstance(ICommandService, {
				executeCommand: async (command: string, ...args: unknown[]) => {
					if (command === 'git.getRepositoryContexts') {
						return ['unrelated', 'session-worktree'].map(id => ({
							id,
							label: id,
							path: `/${id}`,
							root: URI.file(`/${id}`).toString(),
							head: { type: 'branch', name: branch, objectId: 'head' },
							remotes: [],
						}));
					}
					calls.push([command, ...args]);
					if (command === 'git.pull') {
						await started.complete();
						await pending.p;
						if (interrupt === 'failure') {
							throw new Error('Pull conflict');
						}
					}
				},
			} as unknown as ICommandService);
			services.registerInstance(IQuickInputService, {
				createQuickPick: () => {
					throw new Error('One matching repository needs no picker');
				},
			} as unknown as IQuickInputService);
			services.registerInstance(INotificationService, {
				info: () => undefined,
				error: (message: string) => errors.push(message),
			} as unknown as INotificationService);
			const container = document.createElement('div');
			using actions = services.createInstance(SessionSyncChangesActionViewItem, container);
			container.querySelector<HTMLButtonElement>('button')!.click();
			await started.p;
			if (interrupt === 'selection') {
				sessionId = 'other';
				changed.fire();
			}
			if (interrupt === 'branch') {
				branch = 'other';
			}
			await pending.complete();
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(
				calls,
				interrupt === 'none'
					? [
							['git.pull', 'session-worktree'],
							['git.push', 'session-worktree'],
						]
					: [['git.pull', 'session-worktree']],
			);
			assert.deepEqual(
				errors,
				interrupt === 'failure'
					? ['Pull conflict']
					: interrupt === 'branch'
						? ['The repository or branch changed. Start the operation again.']
						: [],
			);
		});
	}
});
