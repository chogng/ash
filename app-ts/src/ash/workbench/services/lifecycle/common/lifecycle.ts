import type { Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export type LifecyclePhase = "running" | "shuttingDown" | "shutdown";
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
	join(operation: Promise<unknown>, label: string): void;
}

/** Coordinates window shutdown participants before their owners are disposed. */
export interface ILifecycleService {
	readonly phase: LifecyclePhase;
	readonly onBeforeShutdown: Event<IBeforeShutdownEvent>;
	readonly onBeforeShutdownError: Event<IBeforeShutdownErrorEvent>;
	readonly onShutdownVeto: Event<void>;
	readonly onWillShutdown: Event<IWillShutdownEvent>;
	readonly onDidShutdown: Event<ShutdownReason>;
	shutdown(reason: ShutdownReason): Promise<void>;
}

export const ILifecycleService = createServiceIdentifier<ILifecycleService>("lifecycleService");
