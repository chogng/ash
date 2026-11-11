import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';

export const checksCollapseStateKey = 'github.checks.collapsedThreads';
export const legacyChecksCollapseStateKey = 'changesView.sessionViewState';
const maxThreads = 64;

export function checksThreadKey(sessionId: string, threadId: string): string {
	return JSON.stringify([sessionId, threadId]);
}

export function readCollapsedChecks(storage: IStorageService): ReadonlySet<string> {
	return new Set(parseCollapsedChecks(storage.get(checksCollapseStateKey, StorageScope.WORKSPACE)));
}

export function setChecksCollapsed(storage: IStorageService, key: string, collapsed: boolean): void {
	const state = new Set(readCollapsedChecks(storage));
	state.delete(key);
	if (collapsed) state.add(key);
	if (state.size > maxThreads) state.delete(state.values().next().value!);
	storage.store(checksCollapseStateKey, JSON.stringify([...state]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

/** Imports the old workspace state, then removes just the Checks field once the new key is durable. */
export async function migrateChecksCollapseState(storage: IStorageService): Promise<void> {
	const legacy = readLegacyChecks(storage);
	if (!legacy) return;
	const target = storage.get(checksCollapseStateKey, StorageScope.WORKSPACE);
	const imported = JSON.stringify(legacy.keys);
	if (target === undefined) storage.store(checksCollapseStateKey, imported, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	else if (target !== imported) {
		const keys = parseCollapsedChecks(target);
		if (!keys || keys.length !== legacy.keys.length
			|| !legacy.keys.every(key => keys.includes(key))) throw new Error('Checks collapse migration conflicts with saved Checks state');
	}
	let changedExternally = false;
	using listener = storage.onDidChangeValue(event => {
		if (event.external && event.scope === StorageScope.WORKSPACE
			&& (event.key === checksCollapseStateKey || event.key === legacyChecksCollapseStateKey)) changedExternally = true;
	});
	await storage.flush();
	const current = readLegacyChecks(storage);
	// The Changes view may save unrelated state, or the window may switch workspaces during the flush.
	if (changedExternally || !current || JSON.stringify(current.state.sections) !== JSON.stringify(legacy.state.sections)
		|| !parseCollapsedChecks(storage.get(checksCollapseStateKey, StorageScope.WORKSPACE))) return;
	const { sections: _sections, ...rest } = current.state;
	storage.store(legacyChecksCollapseStateKey, JSON.stringify(rest), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

function readLegacyChecks(storage: IStorageService): { state: Record<string, unknown>; keys: string[]; } | undefined {
	const state = parse(storage.get(legacyChecksCollapseStateKey, StorageScope.WORKSPACE));
	if (!isRecord(state) || state.version !== 1 || !Array.isArray(state.sections) || state.sections.length > maxThreads) return;
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const entry of state.sections) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !isRecord(entry[1]) || typeof entry[1].checks !== 'boolean') return;
		let resource: URI;
		try { resource = URI.parse(entry[0]); } catch { return; }
		if (resource.scheme !== 'ash-session-changes' || !resource.path.startsWith('/') || resource.path.length < 2 || seen.has(entry[0])) return;
		seen.add(entry[0]);
		const thread = new URLSearchParams(resource.query).get('thread');
		if (!thread && !resource.path.startsWith('/draft/')) return;
		if (thread && entry[1].checks) keys.push(checksThreadKey(resource.path.slice(1), thread));
	}
	return { state, keys: [...new Set(keys)] };
}

function parseCollapsedChecks(raw: string | undefined): string[] | undefined {
	const value = parse(raw);
	if (!Array.isArray(value) || value.length > maxThreads || new Set(value).size !== value.length
		|| !value.every(key => typeof key === 'string' && isThreadKey(key))) return undefined;
	return value;
}

function isThreadKey(key: string): boolean {
	const value = parse(key);
	return Array.isArray(value) && value.length === 2 && value.every(id => typeof id === 'string' && id.length > 0);
}

function parse(value: string | undefined): unknown {
	try { return value === undefined ? undefined : JSON.parse(value); } catch { return undefined; }
}
