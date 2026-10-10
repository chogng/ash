import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { localize } from '../../../../nls.js';

/** Opens saved Session history, optionally at a durable Thread, Turn or event identity. */
export const OpenAgentTraceCommandId = 'ash.agentTrace.open';

export interface AgentTraceLocation {
	readonly sessionId: string;
	readonly threadId?: string;
	readonly turnId?: string;
	readonly eventId?: string;
}

function validateLocation(value: unknown): AgentTraceLocation {
	if (!isRecord(value) || typeof value.sessionId !== 'string' || !value.sessionId.trim() || value.sessionId === 'import') { return invalidLocation(); }
	for (const key of ['sessionId', 'threadId', 'turnId', 'eventId']) {
		const field = value[key];
		if (field !== undefined && (typeof field !== 'string' || !field.trim() || /[\u0000-\u001f\u007f]/.test(field))) { return invalidLocation(); }
	}
	if ((value.turnId !== undefined || value.eventId !== undefined) && value.threadId === undefined) { return invalidLocation(); }
	return value as unknown as AgentTraceLocation;
}

function invalidLocation(): never {
	throw new Error(localize('agentTrace.invalidLocation', 'Invalid execution trace location. A Turn or event requires its Thread ID.'));
}

/** Keeps the locator in editor identity so reopening or switching Turns restores the same target. */
export function createAgentTraceResource(target?: string | AgentTraceLocation): URI {
	if (target === undefined) { return URI.from({ scheme: 'ash-agent-trace', path: '/import' }); }
	const location = validateLocation(typeof target === 'string' ? { sessionId: target } : target);
	const query: string[] = [];
	for (const key of ['threadId', 'turnId', 'eventId'] as const) {
		if (location[key] !== undefined) { query.push(`${key}=${encodeURIComponent(location[key])}`); }
	}
	return URI.from({ scheme: 'ash-agent-trace', path: `/${location.sessionId}`, query: query.join('&') });
}

export function readAgentTraceLocation(resource: URI): AgentTraceLocation | undefined {
	if (resource.scheme !== 'ash-agent-trace' || resource.authority || resource.fragment || !resource.path.startsWith('/')) { return invalidLocation(); }
	if (resource.path === '/import' && !resource.query) { return undefined; }
	const fields: Record<string, string> = { sessionId: resource.path.slice(1) };
	for (const field of resource.query ? resource.query.split('&') : []) {
		const pair = field.split('=');
		if (pair.length !== 2) { return invalidLocation(); }
		let key: string;
		let value: string;
		try { key = decodeURIComponent(pair[0]); value = decodeURIComponent(pair[1]); }
		catch { return invalidLocation(); }
		if (!['threadId', 'turnId', 'eventId'].includes(key) || Object.hasOwn(fields, key)) { return invalidLocation(); }
		fields[key] = value;
	}
	return validateLocation(fields);
}

export const agentTraceEditorId = 'ash.agentTrace';
export const traceEditorId = 'workbench.editor.trace';
export const AgentTraceViewContainerId = 'workbench.view.trace';
export const ResumeAgentTraceCommandId = 'ash.agentTrace.resume';
const lastResourceKey = 'agentTrace.lastResource';

export function rememberAgentTraceResource(storage: IStorageService, resource: URI): void {
	readAgentTraceLocation(resource);
	storage.store(lastResourceKey, resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
}

export function readLastAgentTraceResource(storage: IStorageService): URI | undefined {
	const value = storage.get(lastResourceKey, StorageScope.WORKSPACE);
	if (value === undefined) { return undefined; }
	try { const resource = URI.parse(value); readAgentTraceLocation(resource); return resource; }
	catch { return undefined; }
}

export function createAgentTraceInput(resource: URI): IResourceEditorInput {
	readAgentTraceLocation(resource);
	return { resource, label: localize('agentTrace.title', 'Execution Trace'), readOnly: true, showBreadcrumbs: false };
}
