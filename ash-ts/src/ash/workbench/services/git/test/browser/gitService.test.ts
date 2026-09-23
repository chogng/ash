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

test('GitService applies Auto Fetch mode changes and stops when the workspace closes', async () => {
	const firstId = `repo_${'1'.repeat(64)}`;
	const secondId = `repo_${'2'.repeat(64)}`;
	let repositoryId = firstId;
	const requests: Array<{ repositoryId?: string; mode: string }> = [];
	const api = {
		repositories: async () => ({ repositories: [{ id: repositoryId, label: 'workspace', path: '' }] }),
		fetch: async (params: { readonly repositoryId?: string; readonly mode: string }) => {
			requests.push(params);
			return { status: {
				repositoryId: params.repositoryId,
				streamInstanceId: 'stream-1',
				revision: requests.length,
				workspacePath: '/workspace',
				head: { type: 'unborn', name: 'main' },
				changes: [],
			} };
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'first', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
	await service.listRepositories();
	await assert.rejects(configuration.updateValue(GitConfiguration.autofetchPeriod, 0), /1 to 86400/);
	await configuration.updateValue(GitConfiguration.autofetchPeriod, 1);
	await delay(20);
	assert.deepEqual(requests, []);

	await configuration.updateValue(GitConfiguration.autofetch, true);
	await waitFor(() => requests.length === 1);
	assert.deepEqual(requests[0], { repositoryId: firstId, mode: 'default' });
	await configuration.updateValue(GitConfiguration.autofetch, 'all');
	await waitFor(() => requests.length === 2);
	assert.deepEqual(requests[1], { repositoryId: firstId, mode: 'all' });

	await configuration.updateValue(GitConfiguration.autofetch, false);
	await delay(1100);
	assert.equal(requests.length, 2);

	repositoryId = secondId;
	workspaceContext.updateWorkspace({ id: 'second', uri: URI.file('/second') });
	await service.listRepositories();
	await configuration.updateValue(GitConfiguration.autofetch, true);
	await waitFor(() => requests.length === 3);
	assert.deepEqual(requests[2], { repositoryId: secondId, mode: 'default' });
	workspaceContext.updateWorkspace({ id: 'empty' });
	await delay(1100);
	assert.equal(requests.length, 3);
});

test('GitService fetches repositories independently and stops each when disabled', async () => {
	const firstId = `repo_${'3'.repeat(64)}`;
	const secondId = `repo_${'4'.repeat(64)}`;
	const requests: string[] = [];
	let finishFirst: ((value: unknown) => void) | undefined;
	const api = {
		repositories: async () => ({ repositories: [
			{ id: firstId, label: 'first', path: '' },
			{ id: secondId, label: 'second', path: 'second' },
		] }),
		fetch: (params: { readonly repositoryId: string }) => {
			requests.push(params.repositoryId);
			if (params.repositoryId === firstId) return new Promise(resolve => { finishFirst = resolve; });
			return Promise.resolve({ status: {
				repositoryId: secondId,
				streamInstanceId: 'stream-2',
				revision: 1,
				workspacePath: '/workspace/second',
				head: { type: 'unborn', name: 'main' },
				changes: [],
			} });
		},
	} as unknown as IGitApi;
	const appServerApi = { getConnectionState: async () => 'ready', onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: 'workspace', uri: URI.file('/workspace') });
	using configuration = new WorkbenchConfigurationService();
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext }, configuration, new NullLoggerService());
	await service.listRepositories();
	await configuration.updateValue(GitConfiguration.autofetchPeriod, 1);
	await configuration.updateValue(GitConfiguration.autofetch, true);
	await waitFor(() => requests.length === 2);
	assert.deepEqual(requests, [firstId, secondId]);
	await service.listRepositories();
	await delay(20);
	assert.equal(requests.length, 2);
	await waitFor(() => requests.length === 3, 2000);
	assert.deepEqual(requests, [firstId, secondId, secondId]);
	await configuration.updateValue(GitConfiguration.autofetch, false);
	finishFirst?.({ status: {
		repositoryId: firstId,
		streamInstanceId: 'stream-1',
		revision: 1,
		workspacePath: '/workspace',
		head: { type: 'unborn', name: 'main' },
		changes: [],
	} });
	await delay(20);
	assert.deepEqual(requests, [firstId, secondId, secondId]);
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
