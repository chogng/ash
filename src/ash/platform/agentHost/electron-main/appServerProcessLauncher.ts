import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Creates the process carrying one App Server JSONL connection. */
export interface IAppServerProcessLauncher {
	readonly description: string;
	/** Includes remote profile package installation when a carrier needs a longer cold start. */
	readonly initializeTimeoutMs?: number;
	validate(): void | Promise<void>;
	launch(): ChildProcessWithoutNullStreams;
	/** Commits host-owned runtime selection only after initialize/schema negotiation succeeds. */
	didInitialize?(): void | Promise<void>;
	/** Attempts one typed host-owned recovery after an initialization failure. */
	recoverInitializationFailure?(error: unknown): boolean | Promise<boolean>;
}
