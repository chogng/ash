import { type Event } from "../../../../base/common/event.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface LanguageServerProgressState {
	readonly server: string;
	readonly token: string;
	readonly title: string;
	readonly message?: string;
	readonly percentage?: number;
}

export type LanguageServerLifecycleKind = "starting" | "ready" | "backingOff" | "crashLoop" | "failed" | "stopped";

export interface LanguageServerLifecycleState {
	readonly server: string;
	readonly state: LanguageServerLifecycleKind;
	readonly attempt?: number;
	readonly retryAfterMillis?: number;
	readonly restartAttempts?: number;
	readonly message?: string;
}

/** Window-scoped language-server messages and active work-done progress. */
export interface ILanguageServerStatusService {
	readonly onDidChange: Event<void>;
	getProgress(): readonly LanguageServerProgressState[];
	getStates(): readonly LanguageServerLifecycleState[];
}

export const ILanguageServerStatusService = createServiceIdentifier<ILanguageServerStatusService>("languageServerStatusService");
