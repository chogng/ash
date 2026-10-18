import type { ITerminalProcessCreation, ITerminalReconnectLease } from '../../../../platform/terminal/common/terminal.js';

/** One immutable screen checkpoint, never a second live process or layout model. */
export interface ITerminalSerializedState {
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
}

export interface ITerminalReloadState {
	readonly version: 1;
	readonly workspaceId: string;
	readonly remoteAuthority?: string;
	readonly instances: readonly ITerminalSerializedState[];
	readonly groups: readonly { readonly ids: readonly number[]; readonly sizes: readonly number[]; }[];
	readonly activeId?: number;
	readonly focusedId?: number;
}

export interface ITerminalReloadCredentials {
	readonly stateKey: string;
	readonly expiresAt: number;
	readonly leases: readonly ITerminalReconnectLease[];
}

