import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type LifecyclePhase = "running" | "shuttingDown" | "shutdown";
export type ShutdownReason = "pageHide" | "windowClose" | "reload" | "quit";

export interface IWillShutdownEvent {
	readonly reason: ShutdownReason;
	join(operation: Promise<unknown>, label: string): void;
}

/** Coordinates window shutdown participants before their owners are disposed. */
export interface ILifecycleService {
	readonly phase: LifecyclePhase;
	readonly onWillShutdown: Event<IWillShutdownEvent>;
	readonly onDidShutdown: Event<ShutdownReason>;
	shutdown(reason: ShutdownReason): Promise<void>;
}

export const ILifecycleService = createServiceIdentifier<ILifecycleService>("lifecycleService");
