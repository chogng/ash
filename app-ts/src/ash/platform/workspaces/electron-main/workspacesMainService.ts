import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { IpcRoute } from "../../ipc/electron-main/trustedIpcRouter.js";
import { type IAnyWorkspaceIdentifier, type ISingleFolderWorkspaceIdentifier, type IWorkspace, UNKNOWN_EMPTY_WINDOW_WORKSPACE, isSingleFolderWorkspaceIdentifier, serializeWorkspace, workspaceFromIdentifier } from "../../workspace/common/workspace.js";
import { WORKSPACE_CONTEXT_READ_CHANNEL, validateWorkspaceContextRead } from "../../workspace/common/workspaceIpc.js";
import { type ILocalWorkspaceOpenTarget, type IWorkspaceOpenTarget, WorkspaceOpenTargetKind } from "../common/workspaces.js";
import { type IWorkspacePathService, nodeWorkspacePathService, resolveWorkspace, resolveWorkspaceOpenTarget } from "../node/workspaces.js";

export interface IResolveStartupWorkspaceOptions {
	readonly arguments: readonly string[];
	readonly cwd: string;
}

/**
 * Resolves user-facing workspace targets for native windows.
 *
 * The opened workspace remains window-owned; this service does not duplicate
 * current-window context state.
 */
export class WorkspacesMainService {
	private readonly pathService: IWorkspacePathService;

	constructor(
		pathService: IWorkspacePathService = nodeWorkspacePathService,
	) {
		this.pathService = pathService;
	}

	async resolveStartupWorkspace({
		arguments: args,
		cwd,
	}: IResolveStartupWorkspaceOptions): Promise<IAnyWorkspaceIdentifier> {
		const target = parseWorkspaceLaunchArguments(args);
		if (!target) {
			return UNKNOWN_EMPTY_WINDOW_WORKSPACE;
		}
		return resolveWorkspaceOpenTarget(target, cwd, this.pathService);
	}

	/** Resolves and validates one folder selected by the native folder picker. */
	async resolveFolder(path: string): Promise<ISingleFolderWorkspaceIdentifier> {
		const workspace = await resolveWorkspaceOpenTarget(
			{ kind: WorkspaceOpenTargetKind.Folder, path },
			process.cwd(),
			this.pathService,
		);
		if (!isSingleFolderWorkspaceIdentifier(workspace)) {
			throw new Error("Selected folder did not resolve to a folder workspace");
		}
		return workspace;
	}

	resolveWorkspace(workspace: IAnyWorkspaceIdentifier): Promise<IWorkspace> {
		return resolveWorkspace(workspace, this.pathService);
	}
}

export interface IWorkspaceContextMainChangeEvent {
	readonly previous: IAnyWorkspaceIdentifier;
	readonly workspace: IAnyWorkspaceIdentifier;
	readonly resolvedWorkspace: IWorkspace;
}

/** Mutable main-process owner of the workspace currently hosted by one window. */
export class WorkspaceContextMainService extends Disposable {
	private workspace: IAnyWorkspaceIdentifier;
	private resolvedWorkspace: IWorkspace;
	private readonly _onDidChangeWorkspace = this._register(new Emitter<IWorkspaceContextMainChangeEvent>());

	readonly onDidChangeWorkspace: Event<IWorkspaceContextMainChangeEvent> = this._onDidChangeWorkspace.event;

	constructor(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace = workspaceFromIdentifier(workspace)) {
		super();
		this.workspace = workspace;
		this.resolvedWorkspace = resolvedWorkspace;
	}

	getWorkspace(): IAnyWorkspaceIdentifier {
		return this.workspace;
	}

	getResolvedWorkspace(): IWorkspace {
		return this.resolvedWorkspace;
	}

	updateWorkspace(workspace: IAnyWorkspaceIdentifier, resolvedWorkspace: IWorkspace = workspaceFromIdentifier(workspace)): void {
		if (workspace.id === this.workspace.id) return;
		const previous = this.workspace;
		this.workspace = workspace;
		this.resolvedWorkspace = resolvedWorkspace;
		this._onDidChangeWorkspace.fire({ previous, workspace, resolvedWorkspace });
	}
}

/** Exposes one window-owned workspace identity through the trusted IPC router. */
export function workspaceContextIpcRoutes(
	service: WorkspaceContextMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [{
		channel: WORKSPACE_CONTEXT_READ_CHANNEL,
		validate: validateWorkspaceContextRead,
		invoke: () => serializeWorkspace(service.getResolvedWorkspace()),
	}];
}

/**
 * Parses one project target from user-facing launch arguments.
 *
 * A bare path is classified from the filesystem. Named arguments make the
 * expected target type explicit and reject mismatches.
 */
export function parseWorkspaceLaunchArguments(
	args: readonly string[],
): IWorkspaceOpenTarget | undefined {
	let target: ILocalWorkspaceOpenTarget | undefined;
	let remoteSshHost: string | undefined;
	let positionalOnly = false;

	const accept = (candidate: ILocalWorkspaceOpenTarget): void => {
		if (target) {
			throw new Error("Ash can open only one project per window");
		}
		if (candidate.path.trim().length === 0) {
			throw new Error("Workspace path must not be empty");
		}
		target = candidate;
	};

	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (!positionalOnly && argument === "--") {
			positionalOnly = true;
			continue;
		}
		if (!positionalOnly && argument === "--folder") {
			const path = args[++index];
			if (path === undefined) {
				throw new Error("--folder requires a path");
			}
			accept({ kind: WorkspaceOpenTargetKind.Folder, path });
			continue;
		}
		if (!positionalOnly && argument === "--remote-ssh") {
			const host = args[++index];
			if (host === undefined) throw new Error("--remote-ssh requires an OpenSSH config host");
			if (remoteSshHost !== undefined) throw new Error("--remote-ssh may be specified only once");
			remoteSshHost = host;
			continue;
		}
		if (!positionalOnly && argument.startsWith("--remote-ssh=")) {
			if (remoteSshHost !== undefined) throw new Error("--remote-ssh may be specified only once");
			remoteSshHost = argument.slice("--remote-ssh=".length);
			continue;
		}
		if (!positionalOnly && argument.startsWith("--folder=")) {
			accept({
				kind: WorkspaceOpenTargetKind.Folder,
				path: argument.slice("--folder=".length),
			});
			continue;
		}
		if (!positionalOnly && argument === "--workspace") {
			const path = args[++index];
			if (path === undefined) {
				throw new Error("--workspace requires a path");
			}
			accept({ kind: WorkspaceOpenTargetKind.Workspace, path });
			continue;
		}
		if (!positionalOnly && argument.startsWith("--workspace=")) {
			accept({
				kind: WorkspaceOpenTargetKind.Workspace,
				path: argument.slice("--workspace=".length),
			});
			continue;
		}
		if (!positionalOnly && argument.startsWith("-")) {
			continue;
		}
		accept({ kind: WorkspaceOpenTargetKind.Automatic, path: argument });
	}

	if (!remoteSshHost) return target;
	if (!target) throw new Error("--remote-ssh requires a Remote folder path");
	if (target.kind === WorkspaceOpenTargetKind.Workspace) throw new Error("Remote multi-root workspaces are not supported yet");
	return { kind: WorkspaceOpenTargetKind.RemoteFolder, path: target.path, sshHost: remoteSshHost };
}
