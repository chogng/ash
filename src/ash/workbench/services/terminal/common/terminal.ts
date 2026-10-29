import type {
	ITerminalProcessCreation,
	ITerminalReconnectLease,
	ITerminalProcessCreateOptions,
} from '../../../../platform/terminal/common/terminal.js';

/** Construction borrows a transferred process until its destination screen is ready. */
export interface ITerminalProcessOwnership {
	readonly canTerminate: boolean;
}

/** One immutable screen checkpoint, never a second live process or layout model. */
export interface ITerminalSerializedState {
	readonly environmentVariableCollections?: import('../../../../platform/terminal/common/environmentVariable.js').ISerializableEnvironmentVariableCollections;
	readonly instanceId: number;
	readonly resource: string;
	readonly dirId: string;
	readonly processDirId?: string;
	readonly process: ITerminalProcessCreation;
	readonly title: string;
	readonly customTitle?: string;
	readonly target: number;
	readonly cols: number;
	readonly rows: number;
	readonly sequence: number;
	readonly pendingUtf8: readonly number[];
	readonly vt: string;
	readonly cwd?: string;
	/** Original interactive intent only, before host settings and extension collections.
	 * Task commands, resolved host environment and pending input are never revived. */
	readonly launch?: Readonly<Pick<ITerminalProcessCreateOptions, 'profile' | 'env' | 'strictEnv' | 'cwd'>>;
}

export interface ITerminalReloadState {
	readonly version: 1;
	readonly kind?: 'revive';
	readonly workspaceId: string;
	readonly remoteAuthority?: string;
	readonly instances: readonly ITerminalSerializedState[];
	readonly groups: readonly { readonly ids: readonly number[]; readonly sizes: readonly number[] }[];
	readonly activeId?: number;
	readonly focusedId?: number;
}

export interface ITerminalReloadCredentials {
	readonly stateKey: string;
	readonly expiresAt: number;
	readonly leases: readonly ITerminalReconnectLease[];
}
