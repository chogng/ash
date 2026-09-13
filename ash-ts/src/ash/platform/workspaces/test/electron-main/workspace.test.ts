import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "mocha";
import type { DirGrantDto } from "../../../../../../generated/app-server/index.js";
import { URI } from "../../../../base/common/uri.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import {
	isSingleFolderWorkspaceIdentifier,
	isRemoteWorkspaceIdentifier,
	isWorkspaceIdentifier,
	parseWorkspace,
	parseWorkspaceIdentifier,
	serializeWorkspace,
	serializeWorkspaceIdentifier,
	UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	workbenchStateFromWorkspaceIdentifier,
	workspaceFromIdentifier,
	WorkbenchState,
} from "../../../../platform/workspace/common/workspace.js";
import { createSshRemoteWorkspaceUri } from "../../../../platform/remote/common/remote.js";
import {
	WorkspaceOpenTargetKind,
} from "../../../../platform/workspaces/common/workspaces.js";
import { WorkspaceTransitionFailureKind, WorkspaceTransitionFailureStage, WorkspaceTransitionMainService, WorkspaceTransitionPhase, WorkspaceTransitionRecovery, WorkspaceTransitionStatus } from "../../../../platform/workspaces/electron-main/workspaceTransitionMainService.js";
import { AppServerWorkspaceTransitionAdapter, type IAppServerWorkspaceTransitionHost } from "../../../../platform/workspaces/electron-main/appServerWorkspaceTransition.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { parseWorkspaceLaunchArguments, WorkspaceContextMainService, WorkspacesMainService, workspaceContextIpcRoutes } from "../../../../platform/workspaces/electron-main/workspacesMainService.js";
import {
	getSingleFolderWorkspaceIdentifier,
	getWorkspaceIdentifier,
	type IWorkspacePathService,
	WorkspacePathKind,
} from "../../../../platform/workspaces/node/workspaces.js";
import {
	WorkspaceContextService,
} from "../../../../workbench/services/workspaces/browser/workspaceContextService.js";

test("workspace launch arguments distinguish automatic and named targets", () => {
	assert.equal(parseWorkspaceLaunchArguments([]), undefined);
	assert.deepEqual(parseWorkspaceLaunchArguments(["project"]), {
		kind: WorkspaceOpenTargetKind.Automatic,
		path: "project",
	});
	assert.deepEqual(parseWorkspaceLaunchArguments(["--folder", "project"]), {
		kind: WorkspaceOpenTargetKind.Folder,
		path: "project",
	});
	assert.deepEqual(
		parseWorkspaceLaunchArguments(["--workspace=team.ash-workspace"]),
		{
			kind: WorkspaceOpenTargetKind.Workspace,
			path: "team.ash-workspace",
		},
	);
	assert.deepEqual(parseWorkspaceLaunchArguments(["--", "-project"]), {
		kind: WorkspaceOpenTargetKind.Automatic,
		path: "-project",
	});
	assert.deepEqual(parseWorkspaceLaunchArguments(["--remote-ssh", "work-server", "--folder", "/home/ash/project"]), {
		kind: WorkspaceOpenTargetKind.RemoteFolder,
		path: "/home/ash/project",
		sshHost: "work-server",
	});

	assert.throws(
		() => parseWorkspaceLaunchArguments(["one", "two"]),
		/only one project/,
	);
	assert.throws(
		() => parseWorkspaceLaunchArguments(["--folder"]),
		/requires a path/,
	);
	assert.throws(() => parseWorkspaceLaunchArguments(["--remote-ssh", "work-server"]), /requires a Remote folder/);
	assert.throws(() => parseWorkspaceLaunchArguments(["--remote-ssh", "work-server", "--workspace", "/remote/team.ash-workspace"]), /multi-root/);
});

test("workspaces service resolves SSH folders without reading the local filesystem", async () => {
	let localReads = 0;
	const workspace = await new WorkspacesMainService({
		async resolvePath() {
			localReads += 1;
			throw new Error("Remote path must not be read locally");
		},
	}).resolveStartupWorkspace({
		arguments: ["--remote-ssh=work-server", "--folder=/home/ash/project"],
		cwd: resolve("launch-root"),
	});

	assert.equal(localReads, 0);
	assert.ok(isRemoteWorkspaceIdentifier(workspace));
	assert.equal(workspace.uri.toString(), "ash-remote://ssh+work-server/home/ash/project");
	assert.equal(workspace.id.length, 64);
	assert.equal(new WorkspaceContextService(workspace).getWorkspace().folders[0]?.name, "project");
});

test("workspaces service resolves a canonical single-folder identity", async () => {
	const cwd = resolve("launch-root");
	const canonicalPath = resolve("canonical", "project");
	let requestedPath: string | undefined;
	const pathService: IWorkspacePathService = {
		async resolvePath(path) {
			requestedPath = path;
			return {
				kind: WorkspacePathKind.Directory,
				path: canonicalPath,
			};
		},
	};

	const workspace = await new WorkspacesMainService(pathService)
		.resolveStartupWorkspace({
			arguments: ["project"],
			cwd,
		});

	assert.equal(requestedPath, resolve(cwd, "project"));
	assert.ok(isSingleFolderWorkspaceIdentifier(workspace));
	assert.equal(workspace.id.length, 64);
	assert.equal(workspace.uri.toString(), URI.file(canonicalPath).toString());
	assert.equal(
		workbenchStateFromWorkspaceIdentifier(workspace),
		WorkbenchState.FOLDER,
	);

	const context = new WorkspaceContextService(workspace);
	assert.equal(context.getWorkbenchState(), WorkbenchState.FOLDER);
	assert.equal(context.getWorkspace().folders[0]?.name, "project");
});

test("workspaces service recognizes explicit workspace files", async () => {
	const canonicalPath = resolve("canonical", "team.ash-workspace");
	const pathService: IWorkspacePathService = {
		async resolvePath() {
			return {
				kind: WorkspacePathKind.File,
				path: canonicalPath,
			};
		},
	};

	const workspace = await new WorkspacesMainService(pathService)
		.resolveStartupWorkspace({
			arguments: ["--workspace", "team.ash-workspace"],
			cwd: resolve("launch-root"),
		});

	assert.ok(isWorkspaceIdentifier(workspace));
	assert.equal(
		workspace.configPath.toString(),
		URI.file(canonicalPath).toString(),
	);
	const context = new WorkspaceContextService(workspace);
	assert.equal(context.getWorkbenchState(), WorkbenchState.WORKSPACE);
	assert.equal(context.getWorkspace().name, "team");
});

test("workspaces service resolves ordered folders from VS Code workspace files", async () => {
	const configPath = resolve("canonical", "team.code-workspace");
	const pathService: IWorkspacePathService = {
		async resolvePath(path) {
			return {
				kind: path === configPath ? WorkspacePathKind.File : WorkspacePathKind.Directory,
				path,
			};
		},
		async readFile(path) {
			assert.equal(path, configPath);
			return `{
				// VS Code-compatible JSONC workspace folders.
				"folders": [
					{ "path": "apps/web", "name": "Web Client" },
					{ "path": "../api" },
				],
			}`;
		},
	};
	const service = new WorkspacesMainService(pathService);
	const identity = await service.resolveStartupWorkspace({
		arguments: ["--workspace", configPath],
		cwd: resolve("launch-root"),
	});
	assert.ok(isWorkspaceIdentifier(identity));

	const workspace = await service.resolveWorkspace(identity);
	assert.equal(workspace.name, "team");
	assert.equal(workspace.configuration?.fsPath, configPath);
	assert.deepEqual(workspace.folders.map(folder => ({ name: folder.name, index: folder.index, path: folder.uri.fsPath })), [
		{ name: "Web Client", index: 0, path: resolve("canonical", "apps", "web") },
		{ name: "api", index: 1, path: resolve("api") },
	]);
	assert.notEqual(workspace.folders[0]?.id, workspace.folders[1]?.id);
	assert.equal(new WorkspaceContextService(workspace).getWorkbenchState(), WorkbenchState.WORKSPACE);
});

test("non-empty workspace identifiers are stable for canonical URIs", () => {
	const folderUri = URI.file(resolve("canonical", "project"));
	const configPath = URI.file(resolve("canonical", "team.ash-workspace"));

	assert.equal(
		getSingleFolderWorkspaceIdentifier(folderUri).id,
		getSingleFolderWorkspaceIdentifier(folderUri).id,
	);
	assert.equal(
		getWorkspaceIdentifier(configPath).id,
		getWorkspaceIdentifier(configPath).id,
	);
});

test("loose files and launches without a target remain empty", async () => {
	const filePath = resolve("canonical", "notes.txt");
	const pathService: IWorkspacePathService = {
		async resolvePath() {
			return {
				kind: WorkspacePathKind.File,
				path: filePath,
			};
		},
	};
	const service = new WorkspacesMainService(pathService);

	assert.deepEqual(
		await service.resolveStartupWorkspace({
			arguments: [],
			cwd: resolve("launch-root"),
		}),
		UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	);
	const looseFileWorkspace = await service.resolveStartupWorkspace({
		arguments: ["notes.txt"],
		cwd: resolve("launch-root"),
	});
	assert.deepEqual(looseFileWorkspace, UNKNOWN_EMPTY_WINDOW_WORKSPACE);
	assert.equal(
		workbenchStateFromWorkspaceIdentifier(looseFileWorkspace),
		WorkbenchState.EMPTY,
	);
	assert.equal(
		new WorkspaceContextService(looseFileWorkspace).getWorkbenchState(),
		WorkbenchState.EMPTY,
	);
	await assert.rejects(
		service.resolveStartupWorkspace({
			arguments: ["--folder", "notes.txt"],
			cwd: resolve("launch-root"),
		}),
		/not a directory/,
	);
});

test("workspace identifier IPC validation revives URIs", () => {
	const serializedFolder = {
		id: "folder-id",
		uri: URI.file(resolve("project")).toString(),
	};
	const folder = parseWorkspaceIdentifier(serializedFolder);
	assert.ok(isSingleFolderWorkspaceIdentifier(folder));
	assert.equal(folder.uri.toString(), serializedFolder.uri);
	assert.deepEqual(
		serializeWorkspaceIdentifier(folder),
		serializedFolder,
	);

	assert.throws(
		() => parseWorkspaceIdentifier({ ...serializedFolder, unexpected: true }),
		/exactly/,
	);
	assert.throws(
		() =>
			parseWorkspaceIdentifier({
				id: "folder-id",
				uri: "https://example.com/project",
			}),
		/file or ash-remote scheme/,
	);
	assert.throws(
		() =>
			parseWorkspaceIdentifier({
				id: "folder-id",
				uri: `${serializedFolder.uri}?revision=1`,
			}),
		/query or fragment/,
	);
	assert.throws(
		() => parseWorkspaceIdentifier({ id: "" }),
		/non-empty/,
	);

	const remoteFolder = { id: "remote-folder-id", uri: createSshRemoteWorkspaceUri("work-server", "/home/ash/project").toString() };
	const parsedRemoteFolder = parseWorkspaceIdentifier(remoteFolder);
	assert.ok(isRemoteWorkspaceIdentifier(parsedRemoteFolder));
	assert.deepEqual(serializeWorkspaceIdentifier(parsedRemoteFolder), remoteFolder);
	assert.throws(() => parseWorkspaceIdentifier({ id: "remote-folder-id", uri: "ash-remote://ssh+bad%3Bhost/home/ash/project" }), /Remote|SSH|authority|Invalid/);
	assert.throws(() => parseWorkspaceIdentifier({ id: "remote-folder-id", uri: "ash-remote://ssh+work-server/home/ash%2Fproject" }), /canonical resource identity/);
	assert.throws(() => parseWorkspaceIdentifier({ id: "remote-folder-id", uri: "ash-remote://ssh+work-server/home//ash/project" }), /canonical/);
	assert.throws(() => parseWorkspaceIdentifier({ id: "remote-folder-id", uri: "ash-remote://ssh+work-server/home/ash/project/" }), /canonical/);
});

test("resolved workspace IPC preserves ordered folder identities", () => {
	const serialized = {
		id: "workspace-id",
		folders: [
			{ id: "web-id", uri: URI.file(resolve("web")).toString(), name: "Web", index: 0 },
			{ id: "api-id", uri: URI.file(resolve("api")).toString(), name: "API", index: 1 },
		],
		configuration: URI.file(resolve("team.code-workspace")).toString(),
		name: "team",
	};
	const workspace = parseWorkspace(serialized);
	assert.deepEqual(serializeWorkspace(workspace), serialized);
	assert.equal(workspace.folders[1]?.id, "api-id");
	assert.throws(() => parseWorkspace({ ...serialized, folders: [serialized.folders[1], serialized.folders[0]] }), /indices/);
});

test("workspaces main service exposes a window-owned identity through IPC", async () => {
	const workspace = await new WorkspacesMainService()
		.resolveStartupWorkspace({
			arguments: [],
			cwd: resolve("launch-root"),
		});
	const context = new WorkspaceContextMainService(workspace);
	const [route] = workspaceContextIpcRoutes(context);
	const changes: string[] = [];
	const changeSubscription = context.onDidChangeWorkspace(({ workspace: nextWorkspace }) => {
		changes.push(nextWorkspace.id);
	});

	assert.equal(route.channel, "ash:workspace:context:read");
	assert.equal(route.validate(undefined), undefined);
	assert.throws(() => route.validate({}), /does not accept parameters/);
	assert.deepEqual(
		await route.invoke(undefined),
		serializeWorkspace(workspaceFromIdentifier(UNKNOWN_EMPTY_WINDOW_WORKSPACE)),
	);

	const folder = await new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	}).resolveFolder(resolve("project"));
	context.updateWorkspace(folder);
	context.updateWorkspace(folder);
	assert.deepEqual(
		await route.invoke(undefined),
		serializeWorkspace(workspaceFromIdentifier(folder)),
	);
	assert.deepEqual(changes, [folder.id]);
	changeSubscription.dispose();
	context.dispose();
});

test("workspace transition commits only after the runtime accepts the folder", async () => {
	const workspaces = new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	});
	const context = new WorkspaceContextMainService(
		UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	);
	const runtimeSwitches: string[] = [];
	const grants: DirGrantDto[] = [];
	const transitions = new WorkspaceTransitionMainService({
		workspaces,
		context,
		runtime: {
			async switchWorkspace({ workspace, grant }) {
				runtimeSwitches.push(workspace.uri.fsPath);
				grants.push(grant);
				if (workspace.uri.fsPath.endsWith("rejected")) {
					throw new Error("runtime rejected workspace");
				}
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeRejected,
	});
	const acceptedPath = resolve("project");
	const acceptedGrant: DirGrantDto = { type: "host", permissions: ["readFiles"] };
	const accepted = await transitions.transitionToFolder(acceptedPath, acceptedGrant);

	assert.equal(accepted.status, WorkspaceTransitionStatus.Applied);
	assert.ok(accepted.workspace);
	assert.equal(context.getWorkspace().id, accepted.workspace.id);
	assert.deepEqual(runtimeSwitches, [acceptedPath]);
	assert.deepEqual(grants, [acceptedGrant]);

	const unchanged = await transitions.transitionToFolder(acceptedPath);
	assert.equal(unchanged.status, WorkspaceTransitionStatus.Unchanged);
	assert.deepEqual(runtimeSwitches, [acceptedPath]);

	const rejected = await transitions.transitionToFolder(resolve("rejected"));
	assert.equal(rejected.status, WorkspaceTransitionStatus.Failed);
	assert.equal(rejected.failure?.kind, WorkspaceTransitionFailureKind.RuntimeRejected);
	assert.equal(context.getWorkspace().id, accepted.workspace.id);
});

test("workspace transition accepts a validated Remote identity without reading it as a local path", async () => {
	const workspaces = new WorkspacesMainService();
	const original = getSingleFolderWorkspaceIdentifier(createSshRemoteWorkspaceUri("build-host", "/srv/one"));
	const target = getSingleFolderWorkspaceIdentifier(createSshRemoteWorkspaceUri("build-host", "/srv/two"));
	const context = new WorkspaceContextMainService(original);
	const switchedRoots: string[] = [];
	const transitions = new WorkspaceTransitionMainService({
		workspaces,
		context,
		runtime: {
			async switchWorkspace({ root }) {
				switchedRoots.push(root);
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeRejected,
	});

	const result = await transitions.transitionToWorkspace({ workspace: target, root: "/srv/two" });

	assert.equal(result.status, WorkspaceTransitionStatus.Applied);
	assert.deepEqual(switchedRoots, ["/srv/two"]);
	assert.equal(context.getWorkspace().id, target.id);
});

test("workspace transition serializes concurrent folder requests", async () => {
	const workspaces = new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	});
	const context = new WorkspaceContextMainService(
		UNKNOWN_EMPTY_WINDOW_WORKSPACE,
	);
	let releaseFirstSwitch!: () => void;
	const firstSwitchGate = new Promise<void>((resolve) => {
		releaseFirstSwitch = resolve;
	});
	const switchedPaths: string[] = [];
	const transitions = new WorkspaceTransitionMainService({
		workspaces,
		context,
		runtime: {
			async switchWorkspace({ workspace }) {
				switchedPaths.push(workspace.uri.fsPath);
				if (switchedPaths.length === 1) await firstSwitchGate;
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeRejected,
	});
	const firstPath = resolve("first");
	const secondPath = resolve("second");
	const first = transitions.transitionToFolder(firstPath);
	const second = transitions.transitionToFolder(secondPath);
	await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

	assert.deepEqual(switchedPaths, [firstPath]);
	assert.deepEqual(context.getWorkspace(), UNKNOWN_EMPTY_WINDOW_WORKSPACE);
	releaseFirstSwitch();
	await Promise.all([first, second]);

	assert.deepEqual(switchedPaths, [firstPath, secondPath]);
	const current = context.getWorkspace();
	assert.ok(isSingleFolderWorkspaceIdentifier(current));
	assert.equal(current.uri.fsPath, secondPath);
});

test("workspace transition exposes phases and safely retries recovered runtime loss", async () => {
	const workspaces = new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	});
	const context = new WorkspaceContextMainService(UNKNOWN_EMPTY_WINDOW_WORKSPACE);
	const phases: WorkspaceTransitionPhase[] = [];
	let runtimeAttempts = 0;
	const transitions = new WorkspaceTransitionMainService({
		workspaces,
		context,
		runtime: {
			async switchWorkspace() {
				runtimeAttempts += 1;
				if (runtimeAttempts === 1) throw new Error("connection closed");
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeUnavailable,
		recovery: {
			async recover(failure) {
				assert.equal(failure.kind, WorkspaceTransitionFailureKind.RuntimeUnavailable);
				return WorkspaceTransitionRecovery.Retry;
			},
		},
	});
	transitions.onDidChangeState((state) => phases.push(state.phase));

	const result = await transitions.transitionToFolder(resolve("recovered"));

	assert.equal(result.status, WorkspaceTransitionStatus.Recovered);
	assert.equal(runtimeAttempts, 2);
	assert.deepEqual(phases, [
		WorkspaceTransitionPhase.Resolving,
		WorkspaceTransitionPhase.SwitchingRuntime,
		WorkspaceTransitionPhase.Recovering,
		WorkspaceTransitionPhase.SwitchingRuntime,
		WorkspaceTransitionPhase.Committing,
		WorkspaceTransitionPhase.Idle,
	]);
});

test("workspace transition routes Busy without committing and accepts a later backend transition", async () => {
	const workspaces = new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	});
	const original = UNKNOWN_EMPTY_WINDOW_WORKSPACE;
	const context = new WorkspaceContextMainService(original);
	let runtimeBusy = true;
	const transitions = new WorkspaceTransitionMainService({
		workspaces,
		context,
		runtime: {
			async switchWorkspace() {
				if (runtimeBusy) throw new Error("busy");
			},
		},
		classifyRuntimeError: () => WorkspaceTransitionFailureKind.RuntimeBusy,
	});

	const blocked = await transitions.transitionToFolder(resolve("blocked"));
	assert.equal(blocked.status, WorkspaceTransitionStatus.Blocked);
	assert.equal(context.getWorkspace(), original);
	assert.equal(transitions.state.phase, WorkspaceTransitionPhase.Idle);

	runtimeBusy = false;
	const applied = await transitions.transitionToFolder(resolve("accepted"));
	assert.equal(applied.status, WorkspaceTransitionStatus.Applied);
	assert.equal(context.getWorkspace().id, applied.workspace?.id);
	assert.deepEqual(transitions.state, { phase: WorkspaceTransitionPhase.Idle });
});

test("App Server workspace adapter routes only connection recovery into a retry", async () => {
	let state: ReturnType<IAppServerWorkspaceTransitionHost["getState"]> = "ready";
	const listeners = new Set<Parameters<IAppServerWorkspaceTransitionHost["onStateChange"]>[0]>();
	const switchedRoots: string[] = [];
	const host: IAppServerWorkspaceTransitionHost = {
		getState: () => state,
		async switchWorkspace(root) {
			switchedRoots.push(root);
		},
		onStateChange(listener) {
			listeners.add(listener);
			return toDisposable(() => listeners.delete(listener));
		},
	};
	const adapter = new AppServerWorkspaceTransitionAdapter(host);

	assert.equal(
		adapter.classifyRuntimeError(new AppServerRemoteError(-32071, "Workspace switch is busy", { kind: "EnvCwdSetBusy" })),
		WorkspaceTransitionFailureKind.RuntimeBusy,
	);
	assert.equal(
		adapter.classifyRuntimeError(new AppServerRemoteError(-32070, "Workspace switch is unavailable", { kind: "EnvCwdSetUnavailable" })),
		WorkspaceTransitionFailureKind.RuntimeUnsupported,
	);
	state = "restarting";
	assert.equal(
		adapter.classifyRuntimeError(new Error("connection closed")),
		WorkspaceTransitionFailureKind.RuntimeUnavailable,
	);

	const workspace = await new WorkspacesMainService({
		async resolvePath(path) {
			return { kind: WorkspacePathKind.Directory, path };
		},
	}).resolveFolder(resolve("recovered-by-supervisor"));
	const recovery = adapter.recover({
		transitionId: 1,
		stage: WorkspaceTransitionFailureStage.Runtime,
		kind: WorkspaceTransitionFailureKind.RuntimeUnavailable,
		requestedPath: workspace.uri.fsPath,
		previous: UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		workspace,
		error: new Error("connection closed"),
	});
	await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
	state = "ready";
	for (const listener of listeners) listener(state);

	assert.equal(await recovery, WorkspaceTransitionRecovery.Retry);
	await adapter.switchWorkspace({
		transitionId: 1,
		previous: UNKNOWN_EMPTY_WINDOW_WORKSPACE,
		workspace,
		root: workspace.uri.fsPath,
		grant: { type: "config" },
	});
	assert.deepEqual(switchedRoots, [workspace.uri.fsPath]);
});
