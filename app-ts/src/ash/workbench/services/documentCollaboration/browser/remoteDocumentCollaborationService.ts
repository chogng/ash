import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { isRecord } from "../../../../base/common/types.js";
import { allSelection, nodeSelection, textSelection, type DocumentSelection } from "../../../../editor/common/core/documentSelection.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import { deserializeDocument, serializeDocument } from "../../../../editor/common/model/documentSerialization.js";
import { deserializeDocumentTransaction, serializeDocumentTransaction } from "../../../../editor/common/model/documentTransactionSerialization.js";
import type { DocumentCollaborationRoom } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationInvite } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationMember } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationOpenInput } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationPresence } from "../../../../editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRoomRole } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationSnapshot } from "../../../../editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationSubmitOutcome } from "../../../../editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationEnvelope } from "../../../../editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../../editor/common/services/documentCollaborationService.js";

const API_ROOT = "/v1/document-collaboration";
const INITIAL_POLL_RETRY_DELAY_MS = 250;
const MAXIMUM_POLL_RETRY_DELAY_MS = 5_000;

class RemoteCollaborationRequestError extends Error {
	constructor(message: string, readonly status: number | undefined) {
		super(message);
	}
}

/** Fetch transport for the independently hosted durable Stanza collaboration service. */
export interface RemoteDocumentCollaborationOptions {
	readonly endpoint: string;
	readonly bearerToken: string;
}

export class RemoteDocumentCollaborationService extends Disposable {
	private readonly connections = new Set<RemoteDocumentCollaborationConnection>();

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const connection of [...this.connections]) connection.dispose();
		}));
	}

	async open(input: DocumentCollaborationOpenInput, options: RemoteDocumentCollaborationOptions, signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		throwIfCancelled(signal, "Opening a remote Stanza collaboration room was cancelled");
		const target = normalizeTarget(options.endpoint, options.bearerToken);
		const opened = await this.request(target, "rooms/open", {
			...(input.roomId === undefined ? {} : { roomId: input.roomId }),
			clientId: input.clientId,
			schemaId: input.schemaId,
			document: serializeDocument(input.document, input.schema),
		}, signal);
		throwIfCancelled(signal, "Opening a remote Stanza collaboration room was cancelled");
		const response = expectRecord(opened, "remote collaboration open response");
		const snapshot = decodeSnapshot(response.snapshot, input.schema);
		const clientId = expectString(response.clientId, "remote collaboration clientId");
		const principalId = response.principalId === undefined ? undefined : expectString(response.principalId, "remote collaboration principalId");
		const connection = new RemoteDocumentCollaborationConnection(this, target, input.schema, clientId, principalId, snapshot, expectBooleanOrDefault(response.canEdit, "remote collaboration canEdit", true), expectBooleanOrDefault(response.canManageMembers, "remote collaboration canManageMembers", false));
		this.connections.add(connection);
		return connection;
	}

	remove(connection: RemoteDocumentCollaborationConnection): void {
		this.connections.delete(connection);
	}

	async submit(connection: RemoteDocumentCollaborationConnection, envelope: DocumentCollaborationEnvelope, document: DocumentNode, signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		throwIfCancelled(signal, "Submitting a remote Stanza collaboration update was cancelled");
		const response = expectRecord(await this.request(connection.target, "rooms/submit", {
			roomId: connection.roomId,
			clientId: connection.clientId,
			sequence: validateProtocolInteger(envelope.sequence, "sequence", 1),
			baseVersion: validateProtocolInteger(envelope.baseVersion, "baseVersion", 0),
			transaction: serializeDocumentTransaction(envelope.transaction, connection.schema),
			document: serializeDocument(document, connection.schema),
		}, signal), "remote collaboration submit response");
		throwIfCancelled(signal, "Submitting a remote Stanza collaboration update was cancelled");
		switch (expectString(response.status, "remote collaboration submit status")) {
			case "accepted": return { kind: "accepted", update: decodeUpdate(response.update, connection.schema) };
			case "conflict": return { kind: "conflict", updates: Object.freeze(expectArray(response.updates, "remote collaboration conflict updates").map(update => decodeUpdate(update, connection.schema))) };
			case "resync": return { kind: "resync", snapshot: decodeSnapshot(response.snapshot, connection.schema) };
			default: throw new TypeError("Remote Stanza collaboration returned an unknown submit status");
		}
	}

	async poll(connection: RemoteDocumentCollaborationConnection, signal: AbortSignal): Promise<RemoteReplay> {
		const path = `rooms/${encodeURIComponent(connection.roomId)}/updates?afterVersion=${connection.version}`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), "remote collaboration updates response");
		switch (expectString(response.status, "remote collaboration updates status")) {
			case "updates": return { kind: "updates", updates: Object.freeze(expectArray(response.updates, "remote collaboration updates").map(update => decodeUpdate(update, connection.schema))) };
			case "resync": return { kind: "resync", snapshot: decodeSnapshot(response.snapshot, connection.schema) };
			default: throw new TypeError("Remote Stanza collaboration returned an unknown updates status");
		}
	}

	async updatePresence(connection: RemoteDocumentCollaborationConnection, selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, "Publishing remote Stanza collaboration presence was cancelled");
		await this.request(connection.target, "rooms/presence", {
			roomId: connection.roomId,
			clientId: connection.clientId,
			...(selection === undefined ? {} : { selection: JSON.stringify(selection) }),
		}, signal);
		throwIfCancelled(signal, "Publishing remote Stanza collaboration presence was cancelled");
	}

	async createInvite(connection: RemoteDocumentCollaborationConnection, displayName: string, role: DocumentCollaborationRoomRole, signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		throwIfCancelled(signal, "Creating a remote Stanza collaboration invitation was cancelled");
		const response = expectRecord(await this.request(connection.target, "rooms/invites", {
			roomId: connection.roomId,
			displayName: validateDisplayName(displayName),
			role: validateRoomRole(role),
		}, signal), "remote collaboration invitation response");
		throwIfCancelled(signal, "Creating a remote Stanza collaboration invitation was cancelled");
		return decodeInvite(response, connection.roomId);
	}

	async listMembers(connection: RemoteDocumentCollaborationConnection, signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]> {
		throwIfCancelled(signal, "Reading remote Stanza collaboration members was cancelled");
		const path = `rooms/${encodeURIComponent(connection.roomId)}/members`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), "remote collaboration members response");
		throwIfCancelled(signal, "Reading remote Stanza collaboration members was cancelled");
		return Object.freeze(expectArray(response.members, "remote collaboration members").map(decodeMember));
	}

	async rotateMemberAccessToken(connection: RemoteDocumentCollaborationConnection, principalId: string, signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		throwIfCancelled(signal, "Rotating a remote Stanza collaboration credential was cancelled");
		const response = expectRecord(await this.request(connection.target, "rooms/members/rotate-token", {
			roomId: connection.roomId,
			principalId: validatePrincipalId(principalId),
		}, signal), "remote collaboration credential rotation response");
		throwIfCancelled(signal, "Rotating a remote Stanza collaboration credential was cancelled");
		return decodeInvite(response, connection.roomId);
	}

	async revokeMember(connection: RemoteDocumentCollaborationConnection, principalId: string, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, "Revoking a remote Stanza collaboration member was cancelled");
		await this.request(connection.target, "rooms/members/revoke", {
			roomId: connection.roomId,
			principalId: validatePrincipalId(principalId),
		}, signal);
		throwIfCancelled(signal, "Revoking a remote Stanza collaboration member was cancelled");
	}

	async pollPresence(connection: RemoteDocumentCollaborationConnection, signal: AbortSignal): Promise<RemotePresenceReplay> {
		const path = `rooms/${encodeURIComponent(connection.roomId)}/presence?afterGeneration=${connection.presenceGeneration}`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), "remote collaboration presence response");
		return Object.freeze({
			generation: validateProtocolInteger(response.generation, "presence generation", 0),
			presences: Object.freeze(expectArray(response.presences, "remote collaboration presences").map(value => decodePresence(value))),
		});
	}

	private async request(target: RemoteTarget, path: string, body: object | undefined, signal: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(new URL(`${API_ROOT}/${path}`, target.endpoint), {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${target.bearerToken}`,
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				credentials: "omit",
				signal,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			throwIfCancelled(signal, "Remote Stanza collaboration request was cancelled");
			throw new RemoteCollaborationRequestError(`Remote Stanza collaboration is unavailable: ${error instanceof Error ? error.message : "network request failed"}`, undefined);
		}
		const payload: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const message = payload !== undefined && isRecord(payload) && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
			throw new RemoteCollaborationRequestError(`Remote Stanza collaboration request failed: ${message}`, response.status);
		}
		return payload;
	}
}

class RemoteDocumentCollaborationConnection extends Disposable implements DocumentCollaborationRoom {
	private readonly updateEmitter = this._register(new Emitter<DocumentCollaborationRemoteEnvelope>());
	private readonly snapshotEmitter = this._register(new Emitter<DocumentCollaborationSnapshot>());
	private readonly presenceEmitter = this._register(new Emitter<readonly DocumentCollaborationPresence[]>());
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private polling: AbortController | undefined;
	private presencePolling: AbortController | undefined;
	private readonly presenceHeartbeat: ReturnType<typeof setInterval>;
	private _version: number;
	private _presenceGeneration = 0;
	private _currentPresence: readonly DocumentCollaborationPresence[] = [];
	private presence: DocumentSelection | undefined;

	readonly onDidReceiveUpdate = this.updateEmitter.event;
	readonly onDidReceiveSnapshot = this.snapshotEmitter.event;
	readonly onDidReceivePresence = this.presenceEmitter.event;
	readonly onDidFail = this.failureEmitter.event;
	readonly roomId: string;

	constructor(private readonly service: RemoteDocumentCollaborationService, readonly target: RemoteTarget, readonly schema: DocumentCollaborationRoom["schema"], readonly clientId: string, readonly principalId: string | undefined, readonly initialSnapshot: DocumentCollaborationSnapshot, readonly canEdit: boolean, readonly canManageMembers: boolean) {
		super();
		this.roomId = initialSnapshot.roomId;
		this._version = initialSnapshot.version;
		this.presenceHeartbeat = setInterval(() => this.heartbeatPresence(), 20_000);
		this._register(toDisposable(() => {
			this.polling?.abort();
			this.presencePolling?.abort();
			clearInterval(this.presenceHeartbeat);
			void service.updatePresence(this, undefined, new AbortController().signal).catch(() => undefined);
			service.remove(this);
		}));
		void this.poll();
		void this.pollPresence();
	}

	get version(): number {
		return this._version;
	}

	get presenceGeneration(): number {
		return this._presenceGeneration;
	}

	get currentPresence(): readonly DocumentCollaborationPresence[] {
		return this._currentPresence;
	}

	submit(envelope: DocumentCollaborationEnvelope, document: DocumentNode, signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Remote Stanza collaboration connection is disposed"));
		return this.service.submit(this, envelope, document, signal);
	}

	async updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) throw new ReferenceError("Remote Stanza collaboration connection is disposed");
		await this.service.updatePresence(this, selection, signal);
		this.presence = selection;
	}

	createInvite(displayName: string, role: DocumentCollaborationRoomRole, signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Remote Stanza collaboration connection is disposed"));
		if (!this.canManageMembers) return Promise.reject(new Error("This collaboration member cannot create room invitations"));
		return this.service.createInvite(this, displayName, role, signal);
	}

	listMembers(signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Remote Stanza collaboration connection is disposed"));
		if (!this.canManageMembers) return Promise.reject(new Error("This collaboration member cannot inspect room members"));
		return this.service.listMembers(this, signal);
	}

	rotateMemberAccessToken(principalId: string, signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Remote Stanza collaboration connection is disposed"));
		if (!this.canManageMembers) return Promise.reject(new Error("This collaboration member cannot manage room credentials"));
		return this.service.rotateMemberAccessToken(this, principalId, signal);
	}

	revokeMember(principalId: string, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Remote Stanza collaboration connection is disposed"));
		if (!this.canManageMembers) return Promise.reject(new Error("This collaboration member cannot manage room credentials"));
		return this.service.revokeMember(this, principalId, signal);
	}

	private async poll(): Promise<void> {
		let retryDelay = INITIAL_POLL_RETRY_DELAY_MS;
		while (!this.isDisposed) {
			const polling = new AbortController();
			this.polling = polling;
			try {
				const replay = await this.service.poll(this, polling.signal);
				retryDelay = INITIAL_POLL_RETRY_DELAY_MS;
				if (this.isDisposed || polling.signal.aborted) return;
				if (replay.kind === "resync") {
					this._version = replay.snapshot.version;
					this.snapshotEmitter.fire(replay.snapshot);
					continue;
				}
				for (const update of replay.updates) {
					if (update.version <= this._version) continue;
					this._version = update.version;
					this.updateEmitter.fire(update);
				}
			} catch (error) {
				if (this.isDisposed || polling.signal.aborted) return;
				const failure = error instanceof Error ? error : new Error("Remote Stanza collaboration updates failed");
				if (!isRetryablePollFailure(failure)) {
					this.failureEmitter.fire(failure);
					return;
				}
				await waitForRetry(polling.signal, retryDelay);
				retryDelay = Math.min(retryDelay * 2, MAXIMUM_POLL_RETRY_DELAY_MS);
			} finally {
				if (this.polling === polling) this.polling = undefined;
			}
		}
	}

	private async pollPresence(): Promise<void> {
		let retryDelay = INITIAL_POLL_RETRY_DELAY_MS;
		while (!this.isDisposed) {
			const polling = new AbortController();
			this.presencePolling = polling;
			try {
				const replay = await this.service.pollPresence(this, polling.signal);
				retryDelay = INITIAL_POLL_RETRY_DELAY_MS;
				if (this.isDisposed || polling.signal.aborted) return;
				this._presenceGeneration = replay.generation;
				this._currentPresence = Object.freeze(replay.presences.filter(presence => presence.clientId !== this.clientId));
				this.presenceEmitter.fire(this._currentPresence);
			} catch (error) {
				if (this.isDisposed || polling.signal.aborted) return;
				const failure = error instanceof Error ? error : new Error("Remote Stanza collaboration presence updates failed");
				if (!isRetryablePollFailure(failure)) {
					this.failureEmitter.fire(failure);
					return;
				}
				await waitForRetry(polling.signal, retryDelay);
				retryDelay = Math.min(retryDelay * 2, MAXIMUM_POLL_RETRY_DELAY_MS);
			} finally {
				if (this.presencePolling === polling) this.presencePolling = undefined;
			}
		}
	}

	private heartbeatPresence(): void {
		if (this.isDisposed || this.presence === undefined) return;
		void this.updatePresence(this.presence, new AbortController().signal).catch(error => {
			if (!this.isDisposed) this.failureEmitter.fire(error instanceof Error ? error : new Error("Remote Stanza collaboration presence heartbeat failed"));
		});
	}
}

interface RemoteTarget {
	readonly endpoint: URL;
	readonly bearerToken: string;
}

type RemoteReplay = { readonly kind: "updates"; readonly updates: readonly DocumentCollaborationRemoteEnvelope[] } | { readonly kind: "resync"; readonly snapshot: DocumentCollaborationSnapshot };

interface RemotePresenceReplay {
	readonly generation: number;
	readonly presences: readonly DocumentCollaborationPresence[];
}

function normalizeTarget(endpoint: string, bearerToken: string): RemoteTarget {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		throw new TypeError("Remote Stanza collaboration endpoint must be an absolute HTTP(S) URL");
	}
	if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new TypeError("Remote Stanza collaboration endpoint must be an HTTP(S) origin without a path, credentials, query, or fragment");
	if (bearerToken.length < 32 || !/^[\x21-\x7e]+$/.test(bearerToken)) throw new TypeError("Remote Stanza collaboration bearer token must contain at least 32 visible ASCII characters");
	return Object.freeze({ endpoint: parsed, bearerToken });
}

function decodeSnapshot(value: unknown, schema: DocumentCollaborationRoom["schema"]): DocumentCollaborationSnapshot {
	const record = expectRecord(value, "remote collaboration snapshot");
	return Object.freeze({ roomId: expectString(record.roomId, "remote collaboration roomId"), version: validateProtocolInteger(record.version, "version", 0), document: deserializeDocument(expectString(record.document, "remote collaboration document"), schema) });
}

function decodeUpdate(value: unknown, schema: DocumentCollaborationRoom["schema"]): DocumentCollaborationRemoteEnvelope {
	const record = expectRecord(value, "remote collaboration update");
	return Object.freeze({
		clientId: expectString(record.clientId, "remote collaboration clientId"),
		sequence: validateProtocolInteger(record.sequence, "sequence", 1),
		baseVersion: validateProtocolInteger(record.baseVersion, "baseVersion", 0),
		version: validateProtocolInteger(record.version, "version", 1),
		transaction: deserializeDocumentTransaction(expectString(record.transaction, "remote collaboration transaction"), schema),
	});
}

function decodePresence(value: unknown): DocumentCollaborationPresence {
	const record = expectRecord(value, "remote collaboration presence");
	return Object.freeze({
		clientId: expectString(record.clientId, "remote collaboration presence clientId"),
		selection: decodeSelection(expectString(record.selection, "remote collaboration presence selection")),
	});
}

function decodeInvite(value: Readonly<Record<string, unknown>>, expectedRoomId: string): DocumentCollaborationInvite {
	const roomId = expectString(value.roomId, "remote collaboration invitation roomId");
	if (roomId !== expectedRoomId) throw new TypeError("Remote Stanza collaboration invitation belongs to a different room");
	return Object.freeze({
		roomId,
		principalId: expectString(value.principalId, "remote collaboration invitation principalId"),
		displayName: expectString(value.displayName, "remote collaboration invitation displayName"),
		role: validateRoomRole(value.role),
		accessToken: expectString(value.accessToken, "remote collaboration invitation accessToken"),
	});
}

function decodeMember(value: unknown): DocumentCollaborationMember {
	const record = expectRecord(value, "remote collaboration member");
	return Object.freeze({
		principalId: validatePrincipalId(expectString(record.principalId, "remote collaboration member principalId")),
		displayName: expectString(record.displayName, "remote collaboration member displayName"),
		role: validateRoomRole(record.role),
	});
}

function decodeSelection(value: string): DocumentSelection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("Remote Stanza collaboration presence selection must contain JSON");
	}
	const selection = expectRecord(parsed, "remote collaboration presence selection");
	switch (selection.kind) {
		case "all": return allSelection();
		case "node": return nodeSelection(expectString(selection.nodeId, "remote collaboration node selection nodeId"));
		case "text": return textSelection(decodePoint(selection.anchor, "remote collaboration text selection anchor"), decodePoint(selection.head, "remote collaboration text selection head"));
		default: throw new TypeError("Remote Stanza collaboration presence selection has an unknown kind");
	}
}

function decodePoint(value: unknown, name: string): { readonly nodeId: string; readonly offset: number } {
	const point = expectRecord(value, name);
	return Object.freeze({ nodeId: expectString(point.nodeId, `${name} nodeId`), offset: validateProtocolInteger(point.offset, `${name} offset`, 0) });
}

function expectRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
	return value;
}

function expectArray(value: unknown, name: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
	return value;
}

function expectString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function expectBooleanOrDefault(value: unknown, name: string, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function validateDisplayName(value: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("Remote Stanza collaboration invitation display name must be non-empty");
	return value.trim();
}

function validatePrincipalId(value: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("Remote Stanza collaboration member principalId must contain between 1 and 128 letters, numbers, '-' or '_'");
	return value;
}

function validateRoomRole(value: unknown): DocumentCollaborationRoomRole {
	if (value === "owner" || value === "editor" || value === "viewer") return value;
	throw new TypeError("Remote Stanza collaboration invitation role must be owner, editor, or viewer");
}

function validateProtocolInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Stanza collaboration ${name} must be a safe integer greater than or equal to ${minimum}`);
	return value;
}

function isRetryablePollFailure(error: Error): boolean {
	if (!(error instanceof RemoteCollaborationRequestError)) return false;
	return error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500;
}

function waitForRetry(signal: AbortSignal, delay: number): Promise<void> {
	return new Promise(resolve => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const complete = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", complete);
			resolve();
		};
		const timeout = setTimeout(complete, delay);
		signal.addEventListener("abort", complete, { once: true });
	});
}
