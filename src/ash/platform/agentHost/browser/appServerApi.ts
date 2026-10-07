import type { IAppServerApi, IAppServerSkillApi, IResourceApi, IServerEventApi, SkillCatalog, SkillDescriptor, ResourceMetadataResult } from '../common/appServerApi.js';
import { Event } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { decodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { inertSubscription, type UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { AppServerProtocolClient } from "./appServerProtocolClient.js";
import { appServerRequest, voidResult } from "./appServerRequest.js";

export function createDisconnectedAppServerApi(unavailable: UnavailableOperation): IAppServerApi {
	return {
		connectionGeneration: 0,
		getConnectionState: () => Promise.resolve("stopped"),
		getSlashCommands: () => unavailable("appServer.getSlashCommands"),
		onConnectionState: inertSubscription,
	};
}

export function createDisconnectedResourceApi(unavailable: UnavailableOperation): IResourceApi {
	return {
		connectionGeneration: 0,
		metadata: () => unavailable("resource.metadata"),
		read: () => unavailable("resource.read"),
		release: () => unavailable("resource.release"),
	};
}

export function createDisconnectedServerEventApi(): IServerEventApi {
	return { subscribe: inertSubscription };
}

export function createAppServerAppServerApi(connection: AppServerProtocolClient): IAppServerApi {
	return {
		get connectionGeneration() { return connection.generation; },
		getConnectionState: () => Promise.resolve(connection.state),
		getSlashCommands: () => Promise.resolve(connection.slashCommands),
		onConnectionState: (listener) => connection.onStateChange(listener),
	};
}

export function createAppServerResourceApi(connection: AppServerProtocolClient): IResourceApi {
	return {
		get connectionGeneration() { return connection.generation; },
		metadata: (params) => appServerRequest(connection, "resource/metadata", params),
		read: (params) => appServerRequest(connection, "resource/read", params),
		release: (params) => voidResult(appServerRequest(connection, "resource/release", params)),
	};
}

export function createAppServerServerEventApi(connection: AppServerProtocolClient): IServerEventApi {
	return { subscribe: (listener) => connection.onNotification(listener) };
}

/** Consumes a resource from its opening connection and releases it on every terminal path. */
export async function readAppServerResource(api: IResourceApi, resource: ResourceMetadataResult, maximum: number, signal?: AbortSignal, generation = api.connectionGeneration): Promise<Uint8Array> {
	let failed = false;
	const assertCurrent = () => {
		if (api.connectionGeneration !== generation) throw new Error('Resource belongs to a retired connection');
		if (signal) throwIfCancelled(signal);
	};
	try {
		assertCurrent();
		if (Object.keys(resource).sort().join(',') !== 'mimeType,resourceId,sha256,size' || typeof resource.resourceId !== 'string' || resource.resourceId.length === 0 || resource.resourceId.length > 256 || /[\r\n]/u.test(resource.resourceId) || typeof resource.mimeType !== 'string' || resource.mimeType.length === 0 || resource.mimeType.length > 256 || /[\r\n]/u.test(resource.mimeType)) throw new TypeError('Resource metadata shape is invalid');
		if (!Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > maximum) throw new TypeError('Resource size exceeds the read limit');
		if (!/^sha256:[0-9a-f]{64}$/u.test(resource.sha256)) throw new TypeError('Resource digest is invalid');
		const chunks: VSBuffer[] = [];
		let offset = 0;
		while (offset < resource.size) {
			assertCurrent();
			const chunk = await api.read({ resourceId: resource.resourceId, offset, maxBytes: Math.min(262_144, resource.size - offset) });
			assertCurrent();
			if (Object.keys(chunk).sort().join(',') !== 'dataBase64,decodedLength,eof,offset,resourceId') throw new TypeError('Resource chunk shape is invalid');
			if (typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > 512 * 1024) throw new TypeError('Resource chunk data exceeds the read limit');
			const bytes = decodeBase64(chunk.dataBase64);
			if (chunk.resourceId !== resource.resourceId || chunk.offset !== offset || chunk.decodedLength !== bytes.byteLength || bytes.byteLength === 0 || bytes.byteLength > Math.min(262_144, resource.size - offset)) throw new TypeError('Resource chunk is inconsistent');
			offset += bytes.byteLength;
			if (chunk.eof !== (offset === resource.size)) throw new TypeError('Resource EOF marker is inconsistent');
			chunks.push(bytes);
		}
		const bytes = VSBuffer.concat(chunks).buffer;
		const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
		const actual = `sha256:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
		if (actual !== resource.sha256) throw new Error('Resource digest does not match its metadata');
		assertCurrent();
		return bytes;
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		// Closing the old connection already releases its resources; never target a replacement.
		if (api.connectionGeneration === generation) {
			try { await api.release({ resourceId: resource.resourceId }); }
			// A failed read keeps its original cause even if the connection also rejects cleanup.
			catch (error) { if (!failed) throw error; }
		}
	}
}

export function createDisconnectedSkillOperations(unavailable: UnavailableOperation): IAppServerSkillApi {
	return { onDidChangeSkills: Event.None, list: () => unavailable("skills.list"), read: () => unavailable("skills.read"), setEnabled: () => unavailable("skills.setEnabled"), readInstructions: () => unavailable("skills.readInstructions") };
}

export function createAppServerSkillOperations(connection: AppServerProtocolClient): IAppServerSkillApi {
	return {
		onDidChangeSkills: Event.any(
			(listener, thisArgs) => connection.onNotification(event => { if (event.method === "skills/changed" || event.method === "config/changed") listener.call(thisArgs); }),
			(listener, thisArgs) => connection.onStateChange(state => { if (state === "ready") listener.call(thisArgs); }),
		),
		list: async (reload, sessionId) => normalizeSkillCatalog(await appServerRequest(connection, "skills/list", { reload, sessionId })),
		read: async (sessionId) => {
			const [config, catalog] = await Promise.all([appServerRequest(connection, "config/read", {}), appServerRequest(connection, "skills/list", { reload: "refresh", sessionId })]);
			return { revision: config.revision, catalog: normalizeSkillCatalog(catalog), diagnostics: catalog.diagnostics.map(entry => ({ source: entry.source, subject: entry.subject ?? undefined, message: entry.message })) };
		},
		readInstructions: async (reference, signal, sessionId) => {
			throwIfCancelled(signal);
			const resources = createAppServerResourceApi(connection);
			const generation = resources.connectionGeneration;
			const opened = await appServerRequest(connection, 'skill/resource/open', { sessionId, skillId: reference.id, skillContentDigest: reference.version.digest, path: 'SKILL.md' });
			const bytes = await readAppServerResource(resources, opened.resource, 256 * 1024, signal, generation);
			throwIfCancelled(signal);
			return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		},
		setEnabled: async (skillId, enabled, expectedRevision, sessionId) => {
			await appServerRequest(connection, "skill/enablement/set", { commandId: generateUuid(), expectedRevision, skillId, enablement: enabled ? "enabled" : "disabled", sessionId });
		},
	};
}

function normalizeSkillCatalog(value: unknown): SkillCatalog {
	const catalog = record(value, "Skill catalog");
	if (!Number.isSafeInteger(catalog.generation) || (catalog.generation as number) < 0) throw new TypeError("Skill catalog generation is invalid");
	if (!Array.isArray(catalog.skills)) throw new TypeError("Skill catalog entries must be an array");
	return Object.freeze({
		generation: catalog.generation as number,
		skills: Object.freeze(catalog.skills.map(normalizeSkill)),
	});
}

function normalizeSkill(value: unknown): SkillDescriptor {
	const skill = record(value, "Skill");
	const id = record(skill.id, "Skill identity");
	const source = boundedText(id.source, "Skill source", 256);
	const name = boundedText(id.name, "Skill name", 64);
	const description = boundedText(skill.description, "Skill description", 1024);
	const contentDigest = boundedText(skill.contentDigest, "Skill digest", 96);
	const enablement = boundedText(skill.enablement, "Skill enablement", 16);
	const compatibility = record(skill.compatibility, "Skill compatibility");
	const compatibilityType = boundedText(compatibility.type, "Skill compatibility type", 16);
	if (enablement !== "enabled" && enablement !== "disabled") throw new TypeError("Skill enablement is invalid");
	if (compatibilityType !== "compatible" && compatibilityType !== "unknown") throw new TypeError("Skill compatibility is invalid");
	return Object.freeze({ id: Object.freeze({ source, name }), description, contentDigest, enabled: enablement === "enabled", compatible: compatibilityType === "compatible" });
}

function record(value: unknown, owner: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${owner} must be an object`);
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${owner} is invalid`);
	return value;
}
