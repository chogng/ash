import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { createDisconnectedRendererApi } from '../../../../../workbench/browser/rendererApi.js';
import type { ISessionProviderScope, ISessionProviderScopeService, SessionProviderServices } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import type { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { CreatePullRequestContextView } from '../../browser/createPullRequestContextView.js';
import type { ICreatePullRequestWidgetOptions } from '../../browser/createPullRequestWidget.js';

function fixture() {
	const calls: string[] = [];
	let retired = false;
	let options: ICreatePullRequestWidgetOptions | undefined;
	const base = createDisconnectedRendererApi();
	const host = {
		...base,
		localGit: {
			...base.localGit,
			readRepositoryContexts: async (directory: { sessionId: string; path: string }) => {
				calls.push(`repos:${directory.sessionId}:${directory.path}`);
				return [
					{
						id: 'same-repo',
						label: 'Repo',
						path: '',
						rootPath: '/historical',
						head: { type: 'branch', name: 'feature', objectId: 'a'.repeat(40) },
						remotes: [
							{
								name: 'origin',
								identity: { provider: 'github', host: 'github.com', owner: 'team', repository: 'repo' },
							},
						],
					},
				];
			},
		},
		github: {
			...base.github,
			listAccounts: async () => [{ id: 'account', host: 'github.com', login: 'user', status: 'ready' as const, credentialRevision: 1n }],
			readRepository: async () => ({
				defaultBranch: 'main',
				fullName: 'team/repo',
				allowMergeCommit: true,
				allowSquashMerge: true,
				allowRebaseMerge: false,
				allowAutoMerge: false,
			}),
			createPullRequest: async () => {
				calls.push('create');
				return { number: 7, url: 'https://github.com/team/repo/pull/7', headCommit: 'a'.repeat(40) } as never;
			},
			attachSessionPullRequest: async (sessionId: string) => {
				calls.push(`attach:${sessionId}`);
			},
		},
	};
	const session = {
		sessionId: 'qualified-session',
		title: 'Remote',
		status: 'active',
		nextApprovalMode: 'manual',
		chats: [],
		workspace: { authorityId: 'ssh+builder', root: '/historical' },
	} as ISession;
	const scope: ISessionProviderScope = {
		providerId: 'remote',
		services: { host } as unknown as SessionProviderServices,
		thread: base.thread,
		identity: value => `qualified-${value}`,
		backendIdentity: value => {
			assert.equal(value, session.sessionId);
			return 'same-session';
		},
		assertCurrent: () => {
			if (retired) throw new CancellationError();
		},
	};
	const instantiation = {
		createInstance: (_constructor: unknown, value: ICreatePullRequestWidgetOptions) => {
			options = value;
			return {
				domNode: document.createElement('form'),
				focus: () => {},
				ready: Promise.resolve(),
				...toDisposable(() => {}),
			};
		},
	} as unknown as IInstantiationService;
	const view = new CreatePullRequestContextView(
		instantiation,
		{ container: document.body, show: () => true, hide: () => {}, layout: () => {} } as IContextViewService,
		{
			activeSelection: { kind: 'session', active: { session, threadId: 'qualified-thread' } },
			onDidChange: Event.None,
		} as unknown as ISessionsService,
		{} as IQuickInputService,
		{ getScope: () => scope, onDidChangeScopes: Event.None } as unknown as ISessionProviderScopeService,
		{ info: () => {}, error: () => {} } as unknown as INotificationService,
	);
	return {
		[Symbol.dispose]: () => view.dispose(),
		view,
		calls,
		retire: () => {
			retired = true;
		},
		get creation() {
			assert.ok(options);
			return options.creation;
		},
	};
}

test('PR creation captures the remote historical Session repository and attaches the result through its raw backend identity', async () => {
	using context = fixture();
	await context.view.show(document.body);
	const details = await context.creation.prepare(CancellationToken.None);
	await context.creation.create({
		title: 'Remote change',
		description: '',
		draft: false,
		expectedContext: details.context,
	});
	assert.deepEqual(context.calls, ['repos:same-session:/historical', 'repos:same-session:/historical', 'create', 'attach:same-session']);
});

test('a retired PR scope cannot dispatch a write through a replacement host', async () => {
	using context = fixture();
	await context.view.show(document.body);
	const details = await context.creation.prepare(CancellationToken.None);
	context.retire();
	await assert.rejects(
		context.creation.create({
			title: 'Old change',
			description: '',
			draft: false,
			expectedContext: details.context,
		}),
		{ name: 'CancellationError' },
	);
	assert.deepEqual(context.calls, ['repos:same-session:/historical']);
});
