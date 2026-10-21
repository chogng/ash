/** Workspace-local terminal presentation state consumed by the panel layout. */
export const enum TerminalStorageKeys {
	TabsListWidthHorizontal = 'tabs-list-width-horizontal',
	Reload = 'terminal.reload',
	Revive = 'terminal.revive',
}

import type { ITerminalReloadState, ITerminalReloadCredentials } from '../../../services/terminal/common/terminal.js';
import { isRecord } from '../../../../base/common/types.js';
import { deserializeEnvironmentVariableCollections, serializeEnvironmentVariableCollections } from '../../../../platform/terminal/common/environmentVariableShared.js';

/** Reload state is an untrusted persistence boundary, even in the local profile. */
export function parseTerminalReloadState(text: string): ITerminalReloadState {
	if (text.length > 64 * 1024 * 1024) throw new TypeError('Terminal checkpoint is too large');
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || value.version !== 1 || (value.kind !== undefined && value.kind !== 'revive') || !shortString(value.workspaceId)
		|| (value.remoteAuthority !== undefined && !shortString(value.remoteAuthority))
		|| !Array.isArray(value.instances) || value.instances.length > 64
		|| !Array.isArray(value.groups) || value.groups.length > 64) {
		throw new TypeError('Invalid terminal checkpoint');
	}
	const ids = new Set<number>();
	const processIds = new Set<string>();
	for (const entry of value.instances) {
		if (!isRecord(entry) || !integer(entry.instanceId, 1, Number.MAX_SAFE_INTEGER) || ids.has(entry.instanceId)
			|| !shortString(entry.resource) || !shortString(entry.dirId)
			|| (entry.processDirId !== undefined && !shortString(entry.processDirId))
			|| typeof entry.title !== 'string' || entry.title.length > 4096
			|| (entry.customTitle !== undefined && (typeof entry.customTitle !== 'string' || entry.customTitle.length > 4096))
			|| (entry.target !== 1 && entry.target !== 2)
			|| !integer(entry.cols, 1, 512) || !integer(entry.rows, 1, 512) || !integer(entry.sequence, 0, Number.MAX_SAFE_INTEGER)
			|| typeof entry.vt !== 'string' || entry.vt.length > 16 * 1024 * 1024
			|| (entry.cwd !== undefined && !safeText(entry.cwd))
			|| !Array.isArray(entry.pendingUtf8) || entry.pendingUtf8.length > 3 || !entry.pendingUtf8.every(byte => integer(byte, 0, 255))) {
			throw new TypeError('Invalid terminal screen checkpoint');
		}
		if (entry.launch !== undefined) validateLaunch(entry.launch);
		if (entry.environmentVariableCollections !== undefined) entry.environmentVariableCollections = serializeEnvironmentVariableCollections(deserializeEnvironmentVariableCollections(entry.environmentVariableCollections));
		if (value.kind === 'revive' && entry.launch === undefined) throw new TypeError('Missing terminal revival launch');
		const process = entry.process;
		if (!isRecord(process) || !shortString(process.terminalId) || processIds.has(process.terminalId)
			|| process.connectionPersistence !== 'reconnectable' || !isRecord(process.ready)
			|| !integer(process.ready.pid, 1, 0xffffffff) || typeof process.ready.cwd !== 'string'
			|| !isRecord(process.profile) || !shortString(process.profile.profileId)
			|| typeof process.profile.title !== 'string' || typeof process.profile.isDefault !== 'boolean') {
			throw new TypeError('Invalid terminal process checkpoint');
		}
		ids.add(entry.instanceId);
		processIds.add(process.terminalId);
	}
	const grouped = new Set<number>();
	for (const group of value.groups) {
		if (!isRecord(group) || !Array.isArray(group.ids) || !group.ids.length || !Array.isArray(group.sizes)
			|| group.sizes.length !== group.ids.length || !group.sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0)) {
			throw new TypeError('Invalid terminal split checkpoint');
		}
		for (const id of group.ids) {
			if (typeof id !== 'number' || !ids.has(id) || grouped.has(id)) throw new TypeError('Invalid terminal split member');
			grouped.add(id);
		}
	}
	if ((value.activeId !== undefined && !ids.has(value.activeId as number)) || (value.focusedId !== undefined && !ids.has(value.focusedId as number))) throw new TypeError('Invalid terminal focus checkpoint');
	return value as unknown as ITerminalReloadState;
}

export function parseTerminalReloadCredentials(text: string): ITerminalReloadCredentials {
	if (text.length > 128 * 1024) throw new TypeError('Invalid terminal credentials');
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || typeof value.stateKey !== 'string' || !/^terminal\.reload\.[0-9a-f-]{36}$/u.test(value.stateKey)
		|| typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
		|| !Array.isArray(value.leases) || value.leases.length > 64) {
		throw new TypeError('Invalid terminal credentials');
	}
	const ids = new Set<string>();
	for (const lease of value.leases) {
		if (!isRecord(lease) || !shortString(lease.terminalId) || ids.has(lease.terminalId)
			|| (lease.dirId !== undefined && !shortString(lease.dirId))
			|| typeof lease.reconnectToken !== 'string' || !/^[0-9a-f]{64}$/u.test(lease.reconnectToken)
			|| !integer(lease.reconnectGracePeriodMillis, 0, 300000)) {
			throw new TypeError('Invalid terminal credential');
		}
		ids.add(lease.terminalId);
	}
	return value as unknown as ITerminalReloadCredentials;
}

function shortString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 16384; }
function integer(value: unknown, minimum: number, maximum: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }

function safeText(value: unknown): value is string { return typeof value === 'string' && value.length <= 32768 && !value.includes('\0'); }

function validateLaunch(value: unknown): void {
	if (!isRecord(value) || Object.keys(value).some(key => !['profile', 'env', 'strictEnv', 'cwd'].includes(key))
		|| (value.cwd !== undefined && !safeText(value.cwd)) || (value.strictEnv !== undefined && typeof value.strictEnv !== 'boolean')) throw new TypeError('Invalid terminal revival launch');
	const profile = value.profile;
	if (!isRecord(profile)) throw new TypeError('Invalid terminal revival profile');
	if (profile.type === 'profile') {
		if (!shortString(profile.profileId) || Object.keys(profile).some(key => !['type', 'profileId'].includes(key))) throw new TypeError('Invalid terminal revival profile');
	} else if (profile.type === 'custom') {
		if (!safeText(profile.name) || !Array.isArray(profile.path) || !profile.path.length || profile.path.length > 128 || !profile.path.every(safeText)
			|| !(safeText(profile.args) || Array.isArray(profile.args) && profile.args.length <= 4096 && profile.args.every(safeText))
			|| Object.keys(profile).some(key => !['type', 'name', 'path', 'args'].includes(key))) throw new TypeError('Invalid terminal revival profile');
	} else if (profile.type !== 'default' || Object.keys(profile).length !== 1) throw new TypeError('Invalid terminal revival profile');
	if (value.env !== undefined && (!isRecord(value.env) || Object.keys(value.env).length > 128 || Object.entries(value.env).some(([key, entry]) => !key || key.length > 256 || /[=\0]/u.test(key) || entry !== null && !safeText(entry)))) throw new TypeError('Invalid terminal revival environment');
}

/** Desktop installs a stable window-session key before terminal services start. */
export function parseTerminalReviveStateKey(value: string | undefined): string {
	if (value === undefined) return TerminalStorageKeys.Revive;
	if (!/^terminal\.revive\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw new TypeError('Invalid terminal revival state key');
	return value;
}
