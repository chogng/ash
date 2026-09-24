import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, type IDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { getOrSet } from "../../../../base/common/map.js";
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
import type { IDocumentCollaborationService } from '../common/documentCollaborationService.js';
import type { DocumentCollaborationEnvelope } from "../../../../editor/common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../../editor/common/services/documentCollaborationService.js";
import type { IDocumentCollaborationApi } from "../../../../platform/collaboration/common/documentCollaborationApi.js";
import type { IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import type { DocumentCollaborationPresenceSnapshot as AppServerDocumentCollaborationPresenceSnapshot } from "../../../../platform/app-server/common/generated/index.js";
import type { DocumentCollaborationSnapshot as AppServerDocumentCollaborationSnapshot } from "../../../../platform/app-server/common/generated/index.js";
import type { DocumentCollaborationUpdate as AppServerDocumentCollaborationUpdate } from "../../../../platform/app-server/common/generated/index.js";

/** App Server transport adapter for Stanza's server-ordered collaboration contract. */
export class AppServerDocumentCollaborationService extends Disposable implements IDocumentCollaborationService {
	private readonly connections = new Map<string, Set<AppServerDocumentCollaborationConnection>>();

	constructor(private readonly api: IDocumentCollaborationApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method !== "document/collaboration/update" && event.method !== "document/collaboration/presence") return;
			const connections = this.connections.get(event.params.roomId);
			if (!connections) return;
			for (const connection of connections) {
				if (event.method === "document/collaboration/update") connection.acceptUpdate(event.params);
				else connection.acceptPresence(event.params);
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async open(input: DocumentCollaborationOpenInput, signal: AbortSignal): Promise<DocumentCollaborationRoom> {
		throwIfCancelled(signal, "Opening a Stanza collaboration room was cancelled");
		const opened = await this.api.open({
			...(input.roomId === undefined ? {} : { roomId: input.roomId }),
			clientId: input.clientId,
			schemaId: input.schemaId,
			document: serializeDocument(input.document, input.schema),
		});
		throwIfCancelled(signal, "Opening a Stanza collaboration room was cancelled");
		const snapshot = decodeSnapshot(opened.snapshot, input.schema);
		const connection = new AppServerDocumentCollaborationConnection(this, input.schema, opened.clientId, snapshot);
		const roomConnections = getOrSet(this.connections, connection.roomId, new Set<AppServerDocumentCollaborationConnection>());
		roomConnections.add(connection);
		try {
			connection.acceptPresence(await this.api.readPresence({ roomId: connection.roomId }));
			throwIfCancelled(signal, "Opening a Stanza collaboration room was cancelled");
		} catch (error) {
			connection.dispose();
			throw error;
		}
		return connection;
	}

	remove(connection: AppServerDocumentCollaborationConnection): void {
		const roomConnections = this.connections.get(connection.roomId);
		if (!roomConnections) return;
		roomConnections.delete(connection);
		if (roomConnections.size === 0) this.connections.delete(connection.roomId);
	}

	async submit(connection: AppServerDocumentCollaborationConnection, envelope: DocumentCollaborationEnvelope, document: DocumentNode, signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		throwIfCancelled(signal, "Submitting a Stanza collaboration update was cancelled");
		const submitted = await this.api.submit({
			roomId: connection.roomId,
			clientId: connection.clientId,
			sequence: validateProtocolInteger(envelope.sequence, "sequence", 1),
			baseVersion: validateProtocolInteger(envelope.baseVersion, "baseVersion", 0),
			transaction: serializeDocumentTransaction(envelope.transaction, connection.schema),
			document: serializeDocument(document, connection.schema),
		});
		throwIfCancelled(signal, "Submitting a Stanza collaboration update was cancelled");
		switch (submitted.status) {
			case "accepted": return { kind: "accepted", update: decodeUpdate(submitted.update, connection.schema) };
			case "conflict": return { kind: "conflict", updates: Object.freeze(submitted.updates.map(update => decodeUpdate(update, connection.schema))) };
			case "resync": return { kind: "resync", snapshot: decodeSnapshot(submitted.snapshot, connection.schema) };
		}
	}

	async updatePresence(connection: AppServerDocumentCollaborationConnection, selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, "Publishing Stanza collaboration presence was cancelled");
		await this.api.publishPresence({
			roomId: connection.roomId,
			clientId: connection.clientId,
			...(selection === undefined ? {} : { selection: JSON.stringify(selection) }),
		});
		throwIfCancelled(signal, "Publishing Stanza collaboration presence was cancelled");
	}
}

class AppServerDocumentCollaborationConnection extends Disposable implements DocumentCollaborationRoom {
	private readonly updateEmitter = this._register(new Emitter<DocumentCollaborationRemoteEnvelope>());
	private readonly snapshotEmitter = this._register(new Emitter<DocumentCollaborationSnapshot>());
	private readonly presenceEmitter = this._register(new Emitter<readonly DocumentCollaborationPresence[]>());
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private _presenceGeneration = 0;
	private _currentPresence: readonly DocumentCollaborationPresence[] = [];

	readonly onDidReceiveUpdate = this.updateEmitter.event;
	readonly onDidReceiveSnapshot = this.snapshotEmitter.event;
	readonly onDidReceivePresence = this.presenceEmitter.event;
	readonly onDidFail = this.failureEmitter.event;

	constructor(private readonly service: AppServerDocumentCollaborationService, readonly schema: DocumentCollaborationRoom["schema"], readonly clientId: string, readonly initialSnapshot: DocumentCollaborationSnapshot) {
		super();
		this.roomId = initialSnapshot.roomId;
		this._register(toDisposable(() => {
			void service.updatePresence(this, undefined, new AbortController().signal).catch(() => undefined);
			service.remove(this);
		}));
	}

	readonly roomId: string;
	readonly principalId = undefined;
	readonly canEdit = true;
	readonly canManageMembers = false;

	get currentPresence(): readonly DocumentCollaborationPresence[] {
		return this._currentPresence;
	}

	submit(envelope: DocumentCollaborationEnvelope, document: DocumentNode, signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Stanza collaboration connection is disposed"));
		return this.service.submit(this, envelope, document, signal);
	}

	updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) return Promise.reject(new ReferenceError("Stanza collaboration connection is disposed"));
		return this.service.updatePresence(this, selection, signal);
	}

	createInvite(_displayName: string, _role: DocumentCollaborationRoomRole, _signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		return Promise.reject(new Error("The local App Server collaboration authority does not manage remote room members"));
	}

	listMembers(_signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]> {
		return Promise.reject(new Error("The local App Server collaboration authority does not manage remote room members"));
	}

	rotateMemberAccessToken(_principalId: string, _signal: AbortSignal): Promise<DocumentCollaborationInvite> {
		return Promise.reject(new Error("The local App Server collaboration authority does not manage remote room members"));
	}

	revokeMember(_principalId: string, _signal: AbortSignal): Promise<void> {
		return Promise.reject(new Error("The local App Server collaboration authority does not manage remote room members"));
	}

	acceptUpdate(value: AppServerDocumentCollaborationUpdate): void {
		if (this.isDisposed || value.roomId !== this.roomId) return;
		this.updateEmitter.fire(decodeUpdate(value, this.schema));
	}

	acceptPresence(value: AppServerDocumentCollaborationPresenceSnapshot): void {
		if (this.isDisposed || value.roomId !== this.roomId || value.generation < this._presenceGeneration) return;
		const presence = decodePresence(value);
		this._presenceGeneration = presence.generation;
		this._currentPresence = presence.presences.filter(candidate => candidate.clientId !== this.clientId);
		this.presenceEmitter.fire(this._currentPresence);
	}
}

function decodeSnapshot(value: AppServerDocumentCollaborationSnapshot, schema: DocumentCollaborationRoom["schema"]): DocumentCollaborationSnapshot {
	return Object.freeze({ roomId: value.roomId, version: validateProtocolInteger(value.version, "version", 0), document: deserializeDocument(value.document, schema) });
}

function decodeUpdate(value: AppServerDocumentCollaborationUpdate, schema: DocumentCollaborationRoom["schema"]): DocumentCollaborationRemoteEnvelope {
	return Object.freeze({
		clientId: value.clientId,
		sequence: validateProtocolInteger(value.sequence, "sequence", 1),
		baseVersion: validateProtocolInteger(value.baseVersion, "baseVersion", 0),
		version: validateProtocolInteger(value.version, "version", 1),
		transaction: deserializeDocumentTransaction(value.transaction, schema),
	});
}

function decodePresence(value: AppServerDocumentCollaborationPresenceSnapshot): { readonly generation: number; readonly presences: readonly DocumentCollaborationPresence[] } {
	return Object.freeze({
		generation: validateProtocolInteger(value.generation, "presence generation", 0),
		presences: Object.freeze(value.presences.map(presence => Object.freeze({ clientId: presence.clientId, selection: decodeSelection(presence.selection) }))),
	});
}

function decodeSelection(value: string): DocumentSelection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError("Stanza collaboration presence selection must contain JSON");
	}
	const selection = expectRecord(parsed, "Stanza collaboration presence selection");
	switch (selection.kind) {
		case "all": return allSelection();
		case "node": return nodeSelection(expectString(selection.nodeId, "Stanza collaboration node selection nodeId"));
		case "text": return textSelection(decodePoint(selection.anchor, "Stanza collaboration text selection anchor"), decodePoint(selection.head, "Stanza collaboration text selection head"));
		default: throw new TypeError("Stanza collaboration presence selection has an unknown kind");
	}
}

function decodePoint(value: unknown, name: string): { readonly nodeId: string; readonly offset: number } {
	const point = expectRecord(value, name);
	return Object.freeze({ nodeId: expectString(point.nodeId, `${name} nodeId`), offset: validateProtocolInteger(point.offset, `${name} offset`, 0) });
}

function expectRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function validateProtocolInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Stanza collaboration ${name} must be a safe integer greater than or equal to ${minimum}`);
	return value;
}
