import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IAppServerApi, IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import type { IGitApi } from "../../../../../platform/git/common/gitApi.js";
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { WorkspaceContextService } from "../../../workspaces/browser/workspaceContextService.js";
import { GitService } from "../../browser/gitService.js";
import { GitConfiguration } from '../../common/gitConfiguration.js';

test("GitService keeps empty windows off the App Server and becomes ready with a folder", async () => {
	let statusCalls = 0;
	let repositoryCalls = 0;
	const repositoryId = `repo_${"1".repeat(64)}`;
	const api = {
		async repositories() {
			repositoryCalls += 1;
			return { repositories: [{ id: repositoryId, label: "workspace", path: "" }] };
		},
		async status(params: { readonly repositoryId?: string }) {
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
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
	let readyEvents = 0;
	using ready = service.onDidBecomeReady(() => readyEvents += 1);

	await assert.rejects(service.status(), /GitUnavailable/);
	assert.equal(statusCalls, 0);

	workspaceContext.updateWorkspace({ id: "workspace", uri: URI.file("/workspace") });
	await service.listRepositories();
	assert.equal(readyEvents, 1);
	assert.equal(repositoryCalls, 1);
	assert.equal(service.activeRepository?.id, repositoryId);
	assert.equal((await service.status()).workspacePath, "/workspace");
	assert.equal(statusCalls, 1);
});

test("GitService routes resources and requests to an explicitly selected repository", async () => {
	const rootId = `repo_${"1".repeat(64)}`;
	const nestedId = `repo_${"2".repeat(64)}`;
	const statusRequests: string[] = [];
	const api = {
		repositories: async () => ({ repositories: [
			{ id: rootId, label: "workspace", path: "" },
			{ id: nestedId, label: "nested", path: "packages/nested" },
		] }),
		status: async ({ repositoryId }: { readonly repositoryId?: string }) => {
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
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());

	const repositories = await service.listRepositories();
	assert.deepEqual(repositories.map(repository => [repository.id, repository.root.fsPath]), [
		[rootId, "/workspace"],
		[nestedId, "/workspace/packages/nested"],
	]);
	assert.equal(service.repositoryForResource(URI.file("/workspace/packages/nested/src/file.ts"))?.id, nestedId);
	assert.equal(service.repositoryForResource(URI.file("/workspace/root.ts"))?.id, rootId);

	const selected = await service.selectRepository(nestedId);
	assert.equal(service.activeRepository?.id, nestedId);
	assert.equal(selected.workspacePath, "/workspace/packages/nested");
	assert.deepEqual(statusRequests, [nestedId]);
});

test('GitService reads and writes shared Auto Fetch settings through App Server', async () => {
	let revision = 0;
	let git = { autofetch: 'off', autofetchPeriod: 180 };
	const writes: typeof git[] = [];
	const api = {
		readConfig: async () => ({ revision, git, gitConfigured: revision > 0 }),
		updateConfig: async (params: { expectedRevision: number; git: typeof git }) => {
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
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
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
		updateConfig: async (params: { expectedRevision: number; git: typeof git }) => {
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
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
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
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
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
