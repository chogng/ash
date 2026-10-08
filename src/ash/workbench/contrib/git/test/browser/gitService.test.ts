import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IAppServerApi, IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import type { GitRepositoriesResult, ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IGitApi } from "../../../../../platform/git/common/gitApi.js";
import { WorkbenchConfigurationService } from '../../../../services/configuration/browser/configurationService.js';
import { WorkspaceContextService } from "../../../../services/workspaces/browser/workspaceContextService.js";
import { GitService } from "../../browser/gitService.js";
import { GitConfiguration } from '../../common/gitConfiguration.js';
import { GitWorkspaceError } from '../../common/gitService.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../../base/common/cancellation.js';

test('GitService preserves legacy commit parameters and forwards explicit commit options to the captured repository', async () => {
	const requests: unknown[] = [];
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }, { id: 'nested', label: 'nested', path: 'nested' }] }),
		commit: async (params: unknown) => {
			requests.push(params);
			return { objectId: 'committed', status: { repositoryId: 'nested', streamInstanceId: 'commit-stream', revision: 2, path: 'nested', head: { type: 'branch', name: 'main', objectId: 'committed', upstream: null }, changes: [] } };
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'disconnected', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.listRepositories();
	await service.commit('Legacy staged message', 'nested');
	const result = await service.commit('Signed amended message', 'nested', { scope: 'includeUntracked', mode: 'amend', signoff: 'add', expectedHead: { type: 'branch', name: 'main', objectId: 'captured', upstream: undefined } });
	await service.commit('Detached message', 'nested', { mode: 'amend', expectedHead: { type: 'detached', objectId: 'captured' } });
	assert.deepEqual(requests, [
		{ repositoryId: 'nested', message: 'Legacy staged message' },
		{ repositoryId: 'nested', message: 'Signed amended message', scope: 'includeUntracked', mode: 'amend', signoff: 'add', expectedHead: { type: 'branch', name: 'main', objectId: 'captured', upstream: null } },
		{ repositoryId: 'nested', message: 'Detached message', mode: 'amend', expectedHead: { type: 'detached', objectId: 'captured' } },
	]);
	assert.equal(result.status.workspacePath, '/workspace/nested');
	assert.equal(service.activeRepository?.id, 'root');
});

test('GitService maps ignore notifications to their repository and forwards query cancellation', async () => {
	let notify!: (event: ServerNotification) => void;
	let queryToken: CancellationToken | undefined;
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }, { id: 'nested', label: 'nested', path: 'nested' }] }),
		checkIgnore: async (_params: unknown, token: CancellationToken) => { queryToken = token; return { ignoredPaths: [] }; },
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'disconnected', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi: IServerEventApi = { subscribe: listener => { notify = listener; return toDisposable(() => undefined); } };
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.listRepositories();
	const changes: string[][] = [];
	using listener = service.onDidChangeIgnore(resources => changes.push(resources.map(resource => resource.path)));
	notify({ method: 'git/ignoreChanged', params: { repositoryId: 'nested', paths: ['cache', 'src/file'] } });
	notify({ method: 'git/ignoreChanged', params: { repositoryId: 'root', paths: [] } });
	notify({ method: 'git/ignoreChanged', params: { repositoryId: 'removed', paths: [] } });
	assert.deepEqual(changes, [['/workspace/nested/cache', '/workspace/nested/src/file'], ['/workspace']]);
	using cancellation = new CancellationTokenSource();
	await service.checkIgnore([URI.file('/workspace/nested/cache')], cancellation.token);
	assert.equal(queryToken, cancellation.token);
});

test('GitService retries failed branch queries and reads worktree occupancy afresh', async () => {
	let attempt = 0;
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }] }),
		branches: async () => {
			if (++attempt === 1) throw new Error('Branch query failed');
			return { branches: [{ name: 'topic', objectId: 'commit', current: false, upstream: null, checkedOutElsewhere: attempt === 2 }] };
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'disconnected', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());

	await assert.rejects(service.branches('root'), /Branch query failed/);
	assert.deepEqual(await service.branches('root'), [{ name: 'topic', objectId: 'commit', current: false, upstream: undefined, checkedOutElsewhere: true }]);
	assert.deepEqual(await service.branches('root'), [{ name: 'topic', objectId: 'commit', current: false, upstream: undefined, checkedOutElsewhere: false }]);
});

test('GitService catalog notifications supersede stale discovery and remove the active repository', async () => {
	const pending: Array<(value: GitRepositoriesResult) => void> = [];
	let notify: (event: ServerNotification) => void = () => { throw new Error('missing subscription'); };
	const api = { repositories: () => new Promise<GitRepositoriesResult>(resolve => pending.push(resolve)) } as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'disconnected', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi: IServerEventApi = { subscribe: listener => { notify = listener; return toDisposable(() => undefined); } };
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	const stale = service.listRepositories();
	notify({ method: 'git/repositoriesChanged', params: {} });
	assert.equal(pending.length, 2);
	const fresh = service.listRepositories();
	pending[1]!({ repositories: [{ id: 'new', label: 'new', path: 'nested' }] });
	await fresh;
	assert.equal(service.activeRepository?.id, 'new');
	pending[0]!({ repositories: [] });
	await stale;
	assert.equal(service.activeRepository?.id, 'new');
	notify({ method: 'git/repositoriesChanged', params: {} });
	const removed = service.listRepositories();
	pending[2]!({ repositories: [] });
	await removed;
	assert.equal(service.activeRepository, undefined);
	assert.deepEqual(service.repositories, []);
});

test('GitService routes branch and worktree operations to an explicit repository and keeps session deletion out of Git', async () => {
	const requests: Array<{ operation: string; params: Record<string, unknown>; }> = [];
	const record = (operation: string, params: Record<string, unknown>): void => { requests.push({ operation, params }); };
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }, { id: 'nested', label: 'nested', path: 'nested' }] }),
		createBranch: async (params: Record<string, unknown>) => { record('createBranch', params); return { branches: [] }; },
		deleteBranch: async (params: Record<string, unknown>) => { record('deleteBranch', params); return { branches: [] }; },
		worktrees: async (params: Record<string, unknown>) => {
			record('worktrees', params);
			return { worktrees: [{ checkoutRoot: '/checkouts/one', path: '/checkouts/one/nested', branch: null, head: 'commit', current: false, state: 'ready' }] };
		},
		createWorktree: async (params: Record<string, unknown>) => { record('createWorktree', params); return { path: '/checkouts/two/nested' }; },
		deleteWorktree: async (params: Record<string, unknown>) => { record('deleteWorktree', params); return { worktrees: [] }; },
		resolveWorktree: async (params: Record<string, unknown>) => { record('resolveWorktree', params); return { path: '/checkouts/one/nested' }; },
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.listRepositories();

	assert.equal((await service.getRepository('nested')).id, 'nested');
	await assert.rejects(service.getRepository('missing'), /GitRepositoryNotFound: missing/);
	await service.createBranch('topic', 'nested');
	await service.deleteBranch('topic', 'nested');
	assert.deepEqual(await service.worktrees('nested'), [{ checkoutRoot: '/checkouts/one', path: '/checkouts/one/nested', branch: undefined, head: 'commit', current: false, state: 'ready' }]);
	assert.equal(await service.createWorktree('two', 'nested'), '/checkouts/two/nested');
	await service.deleteWorktree('/checkouts/one', 'nested');
	assert.equal(await service.resolveWorktree('/checkouts/one', 'nested'), '/checkouts/one/nested');
	const deletion = requests.find(request => request.operation === 'deleteWorktree')!;
	assert.match(String(deletion.params.commandId), /^[0-9a-f-]{36}$/);
	delete deletion.params.commandId;
	assert.deepEqual(requests, [
		{ operation: 'createBranch', params: { repositoryId: 'nested', name: 'topic' } },
		{ operation: 'deleteBranch', params: { repositoryId: 'nested', name: 'topic' } },
		{ operation: 'worktrees', params: { repositoryId: 'nested' } },
		{ operation: 'createWorktree', params: { repositoryId: 'nested', name: 'two' } },
		{ operation: 'deleteWorktree', params: { repositoryId: 'nested', checkoutRoot: '/checkouts/one', mode: 'unbound' } },
		{ operation: 'resolveWorktree', params: { repositoryId: 'nested', checkoutRoot: '/checkouts/one' } },
	]);
	assert.equal(service.activeRepository?.id, 'root');
});

test('GitService queries ignore rules in the nearest repository and preserves resource identities', async () => {
	const requests: unknown[] = [];
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }, { id: 'nested', label: 'nested', path: 'nested' }] }),
		status: async (params: { repositoryId: string; }) => ({ repositoryId: params.repositoryId, streamInstanceId: 'ignore-test', revision: 1, path: '', head: { type: 'unborn', name: 'main' }, changes: [] }),
		checkIgnore: async (params: { repositoryId: string; paths: string[]; }) => {
			requests.push(params);
			return { ignoredPaths: params.paths };
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.listRepositories();
	const rootFile = URI.file('/workspace/file.log');
	const nestedFile = URI.file('/workspace/nested/file.log');
	assert.deepEqual(await service.checkIgnore([rootFile, nestedFile, URI.file('/outside/file'), URI.file('/workspace')]), [rootFile, nestedFile]);
	assert.deepEqual(requests, [{ repositoryId: 'root', paths: ['file.log'] }, { repositoryId: 'nested', paths: ['file.log'] }]);
});

test('GitService clones from an empty desktop window through the Git API', async () => {
	const requests: unknown[] = [];
	const api = {
		clone: async (params: unknown) => {
			requests.push(params);
			return { repositoryPath: '/repos/example' };
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'empty-window' });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: true }, configuration, new NullLoggerService());

	assert.equal(await service.cloneRepository('https://example.com/example.git', '/repos'), '/repos/example');
	assert.deepEqual(requests, [{ url: 'https://example.com/example.git', parentPath: '/repos' }]);
});

test("GitService keeps empty windows off the App Server and becomes ready with a folder", async () => {
	let statusCalls = 0;
	let repositoryCalls = 0;
	const repositoryId = `repo_${"1".repeat(64)}`;
	const api = {
		async repositories() {
			repositoryCalls += 1;
			return { repositories: [{ id: repositoryId, label: "workspace", path: "" }] };
		},
		async status(params: { readonly repositoryId?: string; }) {
			statusCalls += 1;
			assert.equal(params.repositoryId, repositoryId);
			return {
				repositoryId,
				streamInstanceId: "stream-1",
				revision: 1,
				workspacePath: "/workspace",
				head: { type: "unborn" as const, name: "main" },
				changes: [],
			};
		},
	} as unknown as IGitApi;
	const appServerApi = {
		getConnectionState: async () => 'ready',
		onConnectionState: () => toDisposable(() => undefined),
	} as unknown as IAppServerApi;
	const eventApi = {
		subscribe: () => toDisposable(() => undefined),
	} as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: "empty-window" });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	let readyEvents = 0;
	using ready = service.onDidBecomeReady(() => readyEvents += 1);

	await assert.rejects(service.status(), (error: unknown) => error instanceof GitWorkspaceError && error.reason === 'noFolder');
	assert.equal(statusCalls, 0);

	workspaceContext.updateWorkspace({ id: "workspace", uri: URI.file("/workspace") });
	await service.listRepositories();
	assert.equal(readyEvents, 1);
	assert.equal(repositoryCalls, 1);
	assert.equal(service.activeRepository?.id, repositoryId);
	assert.equal((await service.status()).workspacePath, URI.file('/workspace').fsPath);
	assert.equal(statusCalls, 1);
});

test('GitService identifies an open folder without a Git repository', async () => {
	const api = { repositories: async () => ({ repositories: [] }) } as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());

	await assert.rejects(service.status(), (error: unknown) => error instanceof GitWorkspaceError && error.reason === 'noRepository');
});

test("GitService routes resources and requests to an explicitly selected repository", async () => {
	const rootId = `repo_${"1".repeat(64)}`;
	const nestedId = `repo_${"2".repeat(64)}`;
	const statusRequests: string[] = [];
	const api = {
		repositories: async () => ({
			repositories: [
				{ id: rootId, label: "workspace", path: "" },
				{ id: nestedId, label: "nested", path: "packages/nested" },
			]
		}),
		status: async ({ repositoryId }: { readonly repositoryId?: string; }) => {
			statusRequests.push(repositoryId ?? "");
			return {
				repositoryId: repositoryId!,
				streamInstanceId: `stream-${repositoryId}`,
				revision: 1,
				workspacePath: ".",
				head: { type: "unborn" as const, name: "main" },
				changes: [],
			};
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: "workspace", uri: URI.file("/workspace") });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());

	const repositories = await service.listRepositories();
	assert.deepEqual(repositories.map(repository => [repository.id, repository.root.fsPath]), [
		[rootId, URI.file('/workspace').fsPath],
		[nestedId, URI.file('/workspace/packages/nested').fsPath],
	]);
	assert.equal(service.repositoryForResource(URI.file("/workspace/packages/nested/src/file.ts"))?.id, nestedId);
	assert.equal(service.repositoryForResource(URI.file("/workspace/root.ts"))?.id, rootId);
	assert.equal(service.repositoryForResource(URI.file('/workspace/packages/nested-other/file.ts'))?.id, rootId);
	assert.equal(service.repositoryForResource(URI.parse('file:///workspace/packages/nested/src/file.ts?revision=1#preview'))?.id, nestedId);
	assert.equal(service.repositoryForResource(URI.file('/outside/file.ts')), undefined);

	const selected = await service.selectRepository(nestedId);
	assert.equal(service.activeRepository?.id, nestedId);
	assert.equal(selected.workspacePath, URI.file('/workspace/packages/nested').fsPath);
	assert.deepEqual(statusRequests, [nestedId]);
});

test('GitService reads and writes shared Auto Fetch settings through App Server', async () => {
	let revision = 0;
	let git = { autofetch: 'off', autofetchPeriod: 180 };
	const writes: typeof git[] = [];
	const api = {
		readConfig: async () => ({ revision, git, gitConfigured: revision > 0 }),
		updateConfig: async (params: { expectedRevision: number; git: typeof git; }) => {
			assert.equal(params.expectedRevision, revision);
			git = params.git;
			writes.push(git);
			revision++;
		},
		fetch: () => { throw new Error('Desktop must not schedule automatic fetch'); },
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'empty-window' });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.setAutoFetch(true);
	assert.equal(service.autoFetch, true);
	await service.setAutoFetchPeriod(60);
	assert.equal(service.autoFetchPeriod, 60);
	await service.setAutoFetch('all');
	assert.deepEqual(writes, [
		{ autofetch: 'default', autofetchPeriod: 180 },
		{ autofetch: 'default', autofetchPeriod: 60 },
		{ autofetch: 'all', autofetchPeriod: 60 },
	]);
	await assert.rejects(service.setAutoFetchPeriod(0), /1 to 86400/);
});

test('GitService migrates persisted Desktop Auto Fetch settings once', async () => {
	let revision = 0;
	let git = { autofetch: 'off', autofetchPeriod: 180 };
	const api = {
		readConfig: async () => ({ revision, git, gitConfigured: revision > 0 }),
		updateConfig: async (params: { expectedRevision: number; git: typeof git; }) => {
			assert.equal(params.expectedRevision, revision);
			git = params.git;
			revision++;
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'empty-window' });
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(GitConfiguration.autofetch, 'all');
	await configuration.updateValue(GitConfiguration.autofetchPeriod, 60);
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await waitFor(() => service.autoFetch === 'all' && service.autoFetchPeriod === 60);
	assert.deepEqual(git, { autofetch: 'all', autofetchPeriod: 60 });
	assert.equal(revision, 1);
	assert.equal(configuration.inspect(GitConfiguration.autofetch).userLocalValue, undefined);
	assert.equal(configuration.inspect(GitConfiguration.autofetchPeriod).userLocalValue, undefined);
});

test('GitService drops repository discovery completed after disposal', async () => {
	let finishDiscovery: ((value: unknown) => void) | undefined;
	const api = {
		repositories: () => new Promise(resolve => { finishDiscovery = resolve; }),
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	const discovery = service.listRepositories();
	service.dispose();
	finishDiscovery?.({ repositories: [{ id: `repo_${'5'.repeat(64)}`, label: 'workspace', path: '' }] });
	assert.deepEqual(await discovery, []);
});

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate() && Date.now() < deadline) await delay(10);
	assert.ok(predicate(), 'expected Auto Fetch request');
}

test('GitService maps integration state and binds partial staging to exact reviewed contents', async () => {
	const calls: unknown[] = [];
	const status = { repositoryId: 'root', streamInstanceId: 'review', revision: 1, path: '', head: { type: 'unborn', name: 'main' }, changes: [] };
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }] }),
		catalog: async (params: unknown) => { calls.push(params); return { tags: [], stashes: [], remotes: [], operation: 'rebase' }; },
		executeCommand: async (params: unknown) => { calls.push(params); return { status, outcome: 'conflicted', operation: 'rebase' }; },
		editIndex: async (params: unknown) => { calls.push(params); return { status }; },
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	assert.equal((await service.catalog('root')).operation, 'rebase');
	const result = await service.executeCommand({ kind: 'continue', operation: 'rebase' }, 'root');
	assert.equal(result.outcome, 'conflicted');
	assert.equal(result.status.workspacePath, URI.file('/workspace').fsPath);
	await service.editIndex('file.txt', 'unstaged', { original: null, modified: 'new\n', hunks: [] }, { kind: 'lines', start: 1, end: 1 }, 'root');
	assert.deepEqual(calls, [
		{ repositoryId: 'root' },
		{ repositoryId: 'root', command: { kind: 'continue', operation: 'rebase' } },
		{ repositoryId: 'root', path: 'file.txt', comparison: 'unstaged', expectedOriginal: null, expectedModified: 'new\n', selection: { kind: 'lines', start: 1, end: 1 } },
	]);
});

test('GitService forwards every fetch target and maps the authoritative upstream remote', async () => {
	const requests: unknown[] = [];
	const status = { repositoryId: 'root', streamInstanceId: 'fetch', revision: 1, path: '', head: { type: 'unborn', name: 'main' }, changes: [] };
	const api = {
		repositories: async () => ({ repositories: [{ id: 'root', label: 'root', path: '' }, { id: 'nested', label: 'nested', path: 'nested' }] }),
		status: async ({ repositoryId }: { repositoryId: string; }) => ({ ...status, repositoryId }),
		catalog: async (params: unknown) => { requests.push(params); return { tags: [], stashes: [], remotes: ['aaa', 'team/backup'], upstreamRemote: 'team/backup', operation: null }; },
		fetch: async (params: unknown) => { requests.push(params); return { status }; },
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'disconnected', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext, canCloneRepository: false }, configuration, new NullLoggerService());
	await service.listRepositories();
	await service.selectRepository('nested');
	assert.equal((await service.catalog('root')).upstreamRemote, 'team/backup');
	for (const target of [undefined, 'default', 'all', { remote: 'team/backup' }] as const) {
		assert.equal((await service.fetch('root', target)).repositoryId, 'root');
	}
	assert.deepEqual(requests, [
		{ repositoryId: 'root' },
		{ repositoryId: 'root', mode: 'all' },
		{ repositoryId: 'root', mode: 'default' },
		{ repositoryId: 'root', mode: 'all' },
		{ repositoryId: 'root', mode: { remote: 'team/backup' } },
	]);
});
