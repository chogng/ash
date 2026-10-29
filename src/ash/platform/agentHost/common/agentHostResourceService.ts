import type { IDisposable, IReference } from '../../../base/common/lifecycle.js';

/** A reference to captured UTF-8 context, scoped to one renderer protocol connection. */
export interface AgentHostResourceSnapshot {
	readonly handle: string;
	readonly byteLength: number;
	readonly sha256: string;
}

/** Snapshot content is owned here only while its initiating request is pending. */
export interface IAgentHostResourceService extends IDisposable {
	createSnapshot(content: string): Promise<IReference<AgentHostResourceSnapshot> | undefined>;
	read(handle: string, offset: number, maximum: number): { readonly bytes: Uint8Array; readonly eof: boolean };
	release(handle: string): void;
	connectionClosed(): void;
}
