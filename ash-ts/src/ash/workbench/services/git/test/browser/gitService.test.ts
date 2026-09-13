import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IAppServerApi, IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { IGitApi } from "../../../../../platform/git/common/gitApi.js";
import { WorkspaceContextService } from "../../../workspaces/browser/workspaceContextService.js";
import { GitService } from "../../browser/gitService.js";

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
		onConnectionState: () => toDisposable(() => undefined),
	} as unknown as IAppServerApi;
	const eventApi = {
		subscribe: () => toDisposable(() => undefined),
	} as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: "empty-window" });
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext });
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
	const appServerApi = { onConnectionState: () => toDisposable(() => undefined) } as unknown as IAppServerApi;
	const eventApi = { subscribe: () => toDisposable(() => undefined) } as unknown as IServerEventApi;
	using workspaceContext = new WorkspaceContextService({ id: "workspace", uri: URI.file("/workspace") });
	using service = new GitService({ api, appServerApi, eventApi, workspaceContext });

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
