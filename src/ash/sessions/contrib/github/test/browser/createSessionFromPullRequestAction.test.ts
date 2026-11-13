import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { GitHubPullRequest } from '../../../../../platform/github/common/githubService.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService } from '../../../../../platform/progress/common/progress.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import * as inputPersistence from '../../../../../workbench/contrib/chat/browser/widget/input/chatInputStatePersistence.js';
import { IExtensionService } from '../../../../../workbench/services/extensions/common/extensionService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { readNewChatDraftState } from '../../../chat/common/newChatDraftState.js';
import '../../browser/createSessionFromPullRequestAction.js';

test('New Session from Pull Request prepares the selected commit and opens the saved snapshot', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	const resources = new DisposableStore();
	resources.add(setARIAContainer(dom.window.document.body as unknown as HTMLElement));
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'pr-session-test', flushInterval: 0 }));
	try {
		const repository = URI.file('/work/repo');
		const pr: GitHubPullRequest = {
			number: 7, title: 'Review checkout', url: 'https://github.com/team/repo/pull/7', body: 'PR details',
			state: 'open', draft: false, mergedAt: null, mergeable: null, headCommit: 'c'.repeat(40),
			headBranch: 'review', headRepository: 'team/fork', baseBranch: 'main', autoMerge: false,
		};
		const github = {
			listAccounts: async () => [{ id: 'account', host: 'github.com', login: 'user', status: 'ready', credentialRevision: 1n }],
			listPullRequests: async () => ({ items: [pr], nextPage: null }),
			readPullRequest: async () => pr,
			listPullRequestFiles: async () => ({ items: [{ filename: 'note', patch: '+PR change' }], nextPage: null }),
			listComments: async () => ({ items: [{ body: 'PR discussion' }], nextPage: null }),
			listPullRequestReviews: async () => ({ items: [{ body: 'PR review' }], nextPage: null }),
			listReviewThreads: async () => ({
				threads: [{ id: 'thread', path: 'note', line: 1, comments: { comments: [{ body: 'Inline review' }], nextCursor: null } }],
				nextCursor: null,
			}),
		};
		const selection = resources.add(new Emitter<void>());
		let selected: IQuickPickItem | undefined;
		let opened = false;
		let created = false;
		const contextKeys = resources.add(new ContextKeyService());
		contextKeys.setContext('isSessionsWindow', true);
		contextKeys.setContext('sessions.workspaceMode', 'code');
		const services = new Map<unknown, unknown>([
			[IContextKeyService, contextKeys],
			[IExtensionService, { activateByEvent: async () => { } }],
			[ICommandService, {
				executeCommand: async () => [{
					id: 'repo', label: 'repo', path: '.', root: repository.toString(),
					head: { type: 'branch', name: 'main' },
					remotes: [{ name: 'origin', identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' } }],
				}]
			}],
			[IQuickInputService, {
				createQuickPick: () => ({
					onDidAccept: selection.event, onDidChangeValue: Event.None, onDidHide: Event.None,
					activeItems: [], get selectedItems() { return selected ? [selected] : []; },
					set items(items: readonly IQuickPickItem[]) {
						const prItem = items.find(item => item.label === '#7 Review checkout');
						if (prItem) { selected = prItem; queueMicrotask(() => selection.fire()); }
					},
					focus() { }, show() { }, [Symbol.dispose]() { },
				})
			}],
			[ISessionProviderScopeService, { getScope: () => ({ providerId: 'local', assertCurrent() { }, services: { host: { github } } }) }],
			[ISessionsProvidersService, { getProvider: () => ({ currentWorkspace: () => ({ type: 'local', root: repository.fsPath }) }) }],
			[ISessionsManagementService, {
				startNewSession: async (...[title, options]: Parameters<ISessionsManagementService['startNewSession']>) => {
					assert.equal(title, '#7 Review checkout');
					assert.equal(options?.providerId, 'local');
					assert.deepEqual(options?.workspace, { type: 'local', root: repository.fsPath });
					assert.deepEqual(options?.creation.worktreeStart, {
						remote: 'origin', remoteIdentity: 'github.com/team/repo', reference: 'refs/pull/7/head', commit: pr.headCommit,
					});
					created = true;
					return { session: { sessionId: 'new-session' }, threadId: 'new-thread' };
				}
			}],
			[ISessionsService, {
				navigationRevision: 0, openThread: async (sessionId: string, threadId: string) => {
					assert.ok(created);
					assert.equal(sessionId, 'new-session');
					assert.equal(threadId, 'new-thread');
					const draft = readNewChatDraftState(storage, threadId, inputPersistence);
					assert.equal(draft?.contexts[0]?.kind, 'transcriptContext');
					assert.equal(draft?.contexts[0]?.resource, pr.url);
					const snapshot = JSON.parse(draft!.contexts[0]!.content);
					assert.equal(snapshot.headCommit, pr.headCommit);
					assert.equal(snapshot.files.entries[0].patch, '+PR change');
					assert.equal(snapshot.discussion.entries[0].body, 'PR discussion');
					assert.equal(snapshot.reviews.entries[0].body, 'PR review');
					assert.equal(snapshot.reviewThreads.entries[0].comments[0].body, 'Inline review');
					opened = true;
				}
			}],
			[IStorageService, storage],
			[IProgressService, { withProgress: async (_: unknown, task: () => Promise<unknown>) => task() }],
			[INotificationService, { status() { } }],
		]);
		const accessor: ServicesAccessor = {
			get: id => {
				assert.ok(services.has(id), String(id));
				return services.get(id) as never;
			},
			getOptional: id => services.get(id) as never,
		};
		await CommandsRegistry.getCommand('sessions.newSessionFromPullRequest')!(accessor);
		assert.ok(opened);
	} finally {
		resources.dispose();
		dom.window.close();
	}
});
