import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

/** Aggregate lifecycle of the extension-process fleet owned by the service. */
export type ExtensionHostState = "stopped" | "starting" | "ready" | "degraded" | "failed";
export type ExtensionRuntimeState = "stopped" | "starting" | "handshaking" | "ready" | "recovering" | "crashLoop" | "failed";
export type ExtensionHostRegistrationKind = "command" | "languageProvider" | "debugAdapter" | "taskProvider" | "testProfileProvider";

/** Stable frontend identity for one registration owned by exactly one extension process. */
export interface ExtensionHostRegistration {
	readonly id: string;
	readonly kind: ExtensionHostRegistrationKind;
}

export interface ExtensionRuntimeFailure {
	readonly code: string;
	readonly incarnation: number | undefined;
	readonly message: string;
}

/** Exact installed package identity attached to one host activation generation. */
export interface ExtensionHostExtension {
	readonly id: string;
	readonly version: string;
	readonly packageDigest: string;
	readonly runtimeApiVersion: number | undefined;
	/** Positive safe integer authority identity (>= 1) required to fence every provider invocation. */
	readonly activationGeneration: number;
	readonly incarnation: number | undefined;
	readonly state: ExtensionRuntimeState;
	readonly failure: ExtensionRuntimeFailure | undefined;
	readonly stderr: string;
	readonly registrations: readonly ExtensionHostRegistration[];
}

/** Immutable frontend projection of one complete extension-process fleet generation. */
export interface ExtensionHostSnapshot {
	/** Non-negative safe integer identifying the complete fleet projection, not one process activation. */
	readonly fleetGeneration: number;
	readonly extensions: readonly ExtensionHostExtension[];
}

export interface ExtensionHostFailure extends ExtensionRuntimeFailure {
	readonly extensionId: string | undefined;
}

/**
 * Workbench lifecycle view of the out-of-process Extension Host.
 *
 * Runtime adapters own transport DTOs, RPC and provider invocation. Consumers only observe
 * frontend-owned identities and lifecycle state; mutable contribution registries remain private to
 * the runtime implementation.
 */
export interface IExtensionHostService extends IDisposable {
	readonly state: ExtensionHostState;
	readonly currentSnapshot: ExtensionHostSnapshot;
	readonly onDidChangeState: Event<ExtensionHostState>;
	readonly onDidChange: Event<ExtensionHostSnapshot>;
	readonly onDidFail: Event<ExtensionHostFailure>;
	start(): Promise<void>;
	reload(): Promise<void>;
	stop(): Promise<void>;
}

export const IExtensionHostService = createServiceIdentifier<IExtensionHostService>("extensionHostService");

export const EmptyExtensionHostSnapshot: ExtensionHostSnapshot = Object.freeze({
	fleetGeneration: 0,
	extensions: Object.freeze([]),
});
