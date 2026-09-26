import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import type { IAnyWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier } from "../../workspace/common/workspace.js";
import type { DirGrant } from "../../dirPermissions/common/dirPermissionsService.js";
import type { WorkspaceContextMainService } from '../../window/electron-main/window.js';
import type { WorkspacesManagementMainService } from './workspacesManagementMainService.js';

export enum WorkspaceTransitionPhase {
	Idle = "idle",
	Resolving = "resolving",
	SwitchingRuntime = "switchingRuntime",
	Committing = "committing",
	Recovering = "recovering",
}

export enum WorkspaceTransitionStatus {
	Unchanged = "unchanged",
	Applied = "applied",
	Recovered = "recovered",
	Blocked = "blocked",
	Failed = "failed",
}

export enum WorkspaceTransitionFailureKind {
	InvalidTarget = "invalidTarget",
	RuntimeBusy = "runtimeBusy",
	RuntimeUnavailable = "runtimeUnavailable",
	RuntimeUnsupported = "runtimeUnsupported",
	RuntimeRejected = "runtimeRejected",
}

export enum WorkspaceTransitionFailureStage {
	Resolve = "resolve",
	Runtime = "runtime",
}

export enum WorkspaceTransitionRecovery {
	KeepCurrent = "keepCurrent",
	Retry = "retry",
	Reconciled = "reconciled",
}

export interface IWorkspaceTransitionContext {
	readonly transitionId: number;
	readonly previous: IAnyWorkspaceIdentifier;
	readonly workspace: ISingleFolderWorkspaceIdentifier;
	readonly root: string;
	readonly grant: DirGrant;
}

export interface IResolvedWorkspaceTransitionTarget {
	readonly workspace: ISingleFolderWorkspaceIdentifier;
	readonly root: string;
}

export interface IWorkspaceRuntimeSwitcher {
	switchWorkspace(context: IWorkspaceTransitionContext): Promise<void>;
}

export interface IWorkspaceTransitionFailure {
	readonly transitionId: number;
	readonly stage: WorkspaceTransitionFailureStage;
	readonly kind: WorkspaceTransitionFailureKind;
	readonly requestedPath: string;
	readonly previous: IAnyWorkspaceIdentifier;
	readonly workspace?: ISingleFolderWorkspaceIdentifier;
	readonly error: unknown;
}

export interface IWorkspaceTransitionRecoveryRouter {
	recover(failure: IWorkspaceTransitionFailure): Promise<WorkspaceTransitionRecovery>;
}

export type WorkspaceTransitionState =
	| { readonly phase: WorkspaceTransitionPhase.Idle }
	| {
		readonly phase: WorkspaceTransitionPhase.Resolving;
		readonly transitionId: number;
		readonly requestedPath: string;
		readonly previous: IAnyWorkspaceIdentifier;
	}
	| {
		readonly phase: WorkspaceTransitionPhase.SwitchingRuntime | WorkspaceTransitionPhase.Committing | WorkspaceTransitionPhase.Recovering;
		readonly transitionId: number;
		readonly requestedPath: string;
		readonly previous: IAnyWorkspaceIdentifier;
		readonly workspace: ISingleFolderWorkspaceIdentifier;
	};

export interface IWorkspaceTransitionResult {
	readonly status: WorkspaceTransitionStatus;
	readonly previous: IAnyWorkspaceIdentifier;
	readonly workspace?: ISingleFolderWorkspaceIdentifier;
	readonly failure?: IWorkspaceTransitionFailure;
}

export interface WorkspaceTransitionMainServiceOptions {
	readonly workspaces: WorkspacesManagementMainService;
	readonly context: WorkspaceContextMainService;
	readonly runtime: IWorkspaceRuntimeSwitcher;
	readonly classifyRuntimeError: (error: unknown) => WorkspaceTransitionFailureKind;
	readonly recovery?: IWorkspaceTransitionRecoveryRouter;
}

interface IRuntimeSwitchResult {
	readonly failure?: IWorkspaceTransitionFailure;
	readonly recovered: boolean;
}

/**
 * Serializes one window's backend Workspace authority transitions.
 *
 * It commits the main-process identity only after App Server runtime acceptance.
 * Renderer projection is deliberately outside this service and reacts to the
 * committed identity through the application assembly boundary.
 */
export class WorkspaceTransitionMainService extends Disposable {
	private readonly workspaces: WorkspacesManagementMainService;
	private readonly context: WorkspaceContextMainService;
	private readonly runtime: IWorkspaceRuntimeSwitcher;
	private readonly classifyRuntimeError: (error: unknown) => WorkspaceTransitionFailureKind;
	private readonly recovery: IWorkspaceTransitionRecoveryRouter;
	private readonly _onDidChangeState = this._register(new Emitter<WorkspaceTransitionState>());
	private transitionQueue: Promise<void> = Promise.resolve();
	private nextTransitionId = 1;
	private _state: WorkspaceTransitionState = { phase: WorkspaceTransitionPhase.Idle };

	readonly onDidChangeState: Event<WorkspaceTransitionState> = this._onDidChangeState.event;

	constructor(options: WorkspaceTransitionMainServiceOptions) {
		super();
		this.workspaces = options.workspaces;
		this.context = options.context;
		this.runtime = options.runtime;
		this.classifyRuntimeError = options.classifyRuntimeError;
		this.recovery = options.recovery ?? keepCurrentRecovery;
	}

	get state(): WorkspaceTransitionState {
		return this._state;
	}

	transitionToFolder(path: string, grant: DirGrant = { type: "config" }): Promise<IWorkspaceTransitionResult> {
		const transition = this.transitionQueue.then(() => this.doTransitionToFolder(path, grant));
		this.transitionQueue = transition.then(() => undefined, () => undefined);
		return transition;
	}

	/** Transitions to an already validated local or Remote single-folder Workspace identity. */
	transitionToWorkspace(target: IResolvedWorkspaceTransitionTarget, grant: DirGrant = { type: "config" }): Promise<IWorkspaceTransitionResult> {
		const transition = this.transitionQueue.then(() => this.doTransitionToWorkspace(target.root, target.workspace, grant));
		this.transitionQueue = transition.then(() => undefined, () => undefined);
		return transition;
	}

	private async doTransitionToFolder(requestedPath: string, grant: DirGrant): Promise<IWorkspaceTransitionResult> {
		const transitionId = this.nextTransitionId++;
		const previous = this.context.getWorkspace();
		this.setState({ phase: WorkspaceTransitionPhase.Resolving, transitionId, requestedPath, previous });

		let workspace: ISingleFolderWorkspaceIdentifier;
		try {
			workspace = await this.workspaces.resolveFolder(requestedPath);
		} catch (error) {
			return this.finishBeforeCommit({
				transitionId,
				stage: WorkspaceTransitionFailureStage.Resolve,
				kind: WorkspaceTransitionFailureKind.InvalidTarget,
				requestedPath,
				previous,
				error,
			});
		}
		return this.doTransitionToWorkspace(requestedPath, workspace, grant, transitionId, previous);
	}

	private async doTransitionToWorkspace(
		requestedPath: string,
		workspace: ISingleFolderWorkspaceIdentifier,
		grant: DirGrant,
		transitionId = this.nextTransitionId++,
		previous = this.context.getWorkspace(),
	): Promise<IWorkspaceTransitionResult> {
		if (workspace.id === previous.id) {
			this.setState({ phase: WorkspaceTransitionPhase.Idle });
			return { status: WorkspaceTransitionStatus.Unchanged, previous, workspace };
		}

		const context = { transitionId, previous, workspace, root: requestedPath, grant };
		const runtime = await this.switchRuntime(requestedPath, context);
		if (runtime.failure) return this.finishBeforeCommit(runtime.failure);

		this.setActiveState(WorkspaceTransitionPhase.Committing, requestedPath, context);
		this.context.updateWorkspace(workspace);
		this.setState({ phase: WorkspaceTransitionPhase.Idle });
		return {
			status: runtime.recovered ? WorkspaceTransitionStatus.Recovered : WorkspaceTransitionStatus.Applied,
			previous,
			workspace,
		};
	}

	private async switchRuntime(requestedPath: string, context: IWorkspaceTransitionContext): Promise<IRuntimeSwitchResult> {
		let recovered = false;
		for (let attempt = 0; attempt < 2; attempt += 1) {
			this.setActiveState(WorkspaceTransitionPhase.SwitchingRuntime, requestedPath, context);
			try {
				await this.runtime.switchWorkspace(context);
				return { recovered };
			} catch (error) {
				const failure: IWorkspaceTransitionFailure = {
					transitionId: context.transitionId,
					stage: WorkspaceTransitionFailureStage.Runtime,
					kind: this.classifyRuntimeError(error),
					requestedPath,
					previous: context.previous,
					workspace: context.workspace,
					error,
				};
				this.setActiveState(WorkspaceTransitionPhase.Recovering, requestedPath, context);
				let recovery: WorkspaceTransitionRecovery;
				try {
					recovery = await this.recovery.recover(failure);
				} catch (recoveryError) {
					return {
						failure: {
							...failure,
							error: new Error("Workspace runtime recovery failed", { cause: recoveryError }),
						},
						recovered,
					};
				}
				if (recovery === WorkspaceTransitionRecovery.Reconciled) return { recovered: true };
				if (recovery !== WorkspaceTransitionRecovery.Retry || attempt > 0) return { failure, recovered };
				recovered = true;
			}
		}
		throw new Error("Workspace transition retry bound was exceeded");
	}

	private finishBeforeCommit(failure: IWorkspaceTransitionFailure): IWorkspaceTransitionResult {
		this.setState({ phase: WorkspaceTransitionPhase.Idle });
		return {
			status: failure.kind === WorkspaceTransitionFailureKind.RuntimeBusy
				? WorkspaceTransitionStatus.Blocked
				: WorkspaceTransitionStatus.Failed,
			previous: failure.previous,
			workspace: failure.workspace,
			failure,
		};
	}

	private setActiveState(
		phase: WorkspaceTransitionPhase.SwitchingRuntime | WorkspaceTransitionPhase.Committing | WorkspaceTransitionPhase.Recovering,
		requestedPath: string,
		context: IWorkspaceTransitionContext,
	): void {
		this.setState({ phase, transitionId: context.transitionId, requestedPath, previous: context.previous, workspace: context.workspace });
	}

	private setState(state: WorkspaceTransitionState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
	}
}

const keepCurrentRecovery: IWorkspaceTransitionRecoveryRouter = {
	async recover() {
		return WorkspaceTransitionRecovery.KeepCurrent;
	},
};
