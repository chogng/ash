import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Startup progress; shutdown does not move this phase backwards. */
export enum LifecyclePhase {
	Starting = 1,
	/** Services are assembled; UI restoration can begin. */
	Ready = 2,
	/** Editors, working copies and views have finished their startup restoration. */
	Restored = 3,
	/** Deferred work may run after the restored window has had time to settle. */
	Eventually = 4,
}

export enum StartupKind {
	NewWindow = 1,
	ReloadedWindow = 3,
	ReopenedWindow = 4,
}

export type ShutdownReason = "pageHide" | "windowClose" | "reload" | "load" | "quit";

export interface IBeforeShutdownEvent {
	readonly reason: ShutdownReason;
	veto(value: boolean | Promise<boolean>, id: string): void;
}

export interface IBeforeShutdownErrorEvent {
	readonly reason: ShutdownReason;
	readonly error: Error;
}

export class ShutdownVetoError extends Error {
	constructor() {
		super('Window shutdown was vetoed');
	}
}

export interface IWillShutdownEvent {
	readonly reason: ShutdownReason;
	/** Promise joins settle first. Final callbacks may repeat until their current-state check permits completion. */
	join(operation: Promise<unknown> | (() => Promise<unknown>), label: string, isCurrent?: () => boolean): void;
}

/** Owns startup milestones and coordinates shutdown before window resources are disposed. */
export interface ILifecycleService {
	readonly startupKind: StartupKind;
	phase: LifecyclePhase;
	/** True after shutdown checks permit closing; failed shutdown joins reset it. */
	readonly willShutdown: boolean;
	readonly onBeforeShutdown: Event<IBeforeShutdownEvent>;
	readonly onBeforeShutdownError: Event<IBeforeShutdownErrorEvent>;
	readonly onShutdownVeto: Event<void>;
	readonly onWillShutdown: Event<IWillShutdownEvent>;
	/** Fires after all joins settle on failure and state resets, before the host resumes editing. */
	readonly onDidShutdownError: Event<ShutdownReason>;
	readonly onDidShutdown: Event<ShutdownReason>;
	/** Resolves when this milestone or a later phase is reached. */
	when(phase: LifecyclePhase): Promise<void>;
	shutdown(reason: ShutdownReason): Promise<void>;
}

export const ILifecycleService = createServiceIdentifier<ILifecycleService>("lifecycleService");
