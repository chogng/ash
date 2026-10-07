import type { Event } from "../../../../base/common/event.js";
import type { IDisposable } from "../../../../base/common/lifecycle.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";

export interface IDebugConsoleSession {
	readonly id: string;
	readonly label: string;
	readonly state: "starting" | "running" | "stopped" | "terminated" | "error";
	readonly output: string;
	readonly canEvaluate: boolean;
}

/** Retained, session-aware Debug Console model kept separate from generic Output channels. */
export interface IDebugConsoleService extends IDisposable {
	readonly sessions: readonly IDebugConsoleSession[];
	readonly activeSession: IDebugConsoleSession | undefined;
	readonly onDidChange: Event<void>;
	selectSession(id: string): void;
	clear(sessionId?: string): void;
	evaluate(expression: string): Promise<void>;
}

export const IDebugConsoleService = createServiceIdentifier<IDebugConsoleService>("debugConsoleService");
