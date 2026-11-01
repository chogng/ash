import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IAppServerByteTransport } from '../common/appServerTransport.js';

/** Native acquisition can supply either a process stream or an authenticated socket. */
export interface IAppServerTransportLauncher {
	readonly description: string;
	readonly initializeTimeoutMs?: number;
	validate(): void | Promise<void>;
	openTransport(): Promise<IAppServerByteTransport>;
	didInitialize?(): void | Promise<void>;
	recoverInitializationFailure?(error: unknown): boolean | Promise<boolean>;
}

export type AppServerConnectionLauncher = IAppServerProcessLauncher | IAppServerTransportLauncher;

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
