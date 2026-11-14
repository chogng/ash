import { CollabError, CollabFailure, type RoomStatus } from '../common/collabService.js';
import { AppServerRemoteError } from '../../../../platform/agentHost/common/appServerError.js';
import type { ICollabService, RejoinableRoom } from '../common/collabService.js';
import type { RoomCodec } from '../common/collabService.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getOrSet } from '../../../../base/common/map.js';
import type { DocumentSelection } from '../../documentEditor/common/documentCodec.js';
import type { DocumentNode } from '../../documentEditor/common/documentCodec.js';
import type { Room } from '../common/collabService.js';
import type { RoomInvite } from '../common/collabService.js';
import type { RoomMember } from '../common/collabService.js';
import type { RoomOpenInput } from '../common/collabService.js';
import type { RoomPresence } from '../common/collabService.js';
import type { RoomRole } from '../common/collabService.js';
import type { RoomSnapshot } from '../common/collabService.js';
import type { RoomSubmitOutcome } from '../common/collabService.js';
import type { IDocumentRoomService } from '../common/collabService.js';
import type { RoomEnvelope } from '../common/collabService.js';
import type { RemoteRoomEnvelope } from '../common/collabService.js';
import type { ICollabApi } from '../../../../platform/collab/common/collabApi.js';
import type { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { RoomPresenceSnapshot as AppServerRoomPresenceSnapshot } from '../../../../../../.build/protocol/typescript/index.js';
import type { RoomSnapshot as AppServerRoomSnapshot } from '../../../../../../.build/protocol/typescript/index.js';
import type { RoomUpdate as AppServerRoomUpdate } from '../../../../../../.build/protocol/typescript/index.js';

interface AppServerUpdateReceiver {
	readonly roomId: string;
	acceptUpdate(value: AppServerRoomUpdate): void;
	acceptPresence(value: AppServerRoomPresenceSnapshot): void;
}

/** App Server transport adapter for Stanza's server-ordered collaboration contract. */
export class AppServerCollabService extends Disposable implements IDocumentRoomService, ICollabService {
	private readonly connections = new Map<string, Set<AppServerUpdateReceiver>>();

	constructor(private readonly api: ICollabApi, events: IServerEventApi) {
		super();
		const subscription = events.subscribe(event => {
			if (event.method !== 'document/collaboration/update' && event.method !== 'document/collaboration/presence') return;
			const connections = this.connections.get(event.params.roomId);
			if (!connections) return;
			for (const connection of connections) {
				if (event.method === 'document/collaboration/update') connection.acceptUpdate(event.params);
				else connection.acceptPresence(event.params);
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
	}

	async open<TDocument, TTransaction>(input: RoomOpenInput<TDocument, TTransaction>, signal: AbortSignal): Promise<RejoinableRoom<TDocument, TTransaction>> {
		throwIfCancelled(signal, 'Opening a Stanza collaboration room was cancelled');
		const opened = await this.api.open({
			...(input.roomId === undefined ? {} : { roomId: input.roomId }),
			clientId: input.clientId,
			schemaId: input.schemaId,
			document: input.codec.serialize(input.document),
			...(input.lease === undefined ? {} : { lease: input.lease }),
		});
		throwIfCancelled(signal, 'Opening a Stanza collaboration room was cancelled');
		if (opened.schemaId !== input.schemaId || opened.clientId !== input.clientId || (input.roomId !== undefined && opened.snapshot.roomId !== input.roomId)) throw new TypeError('Unexpected collaboration room identity');
		const snapshot = decodeSnapshot(opened.snapshot, input.codec);
		const connection = new AppServerRoom(this, input.codec, opened.clientId, snapshot, input.schemaId, input.lease);
		const roomConnections = getOrSet(this.connections, connection.roomId, new Set<AppServerUpdateReceiver>());
		roomConnections.add(connection);
		try {
			connection.acceptPresence(await this.api.readPresence({ roomId: connection.roomId }));
			throwIfCancelled(signal, 'Opening a Stanza collaboration room was cancelled');
		} catch (error) {
			connection.dispose();
			throw error;
		}
		return connection;
	}

	remove(connection: AppServerUpdateReceiver): void {
		const roomConnections = this.connections.get(connection.roomId);
		if (!roomConnections) return;
		roomConnections.delete(connection);
		if (roomConnections.size === 0) this.connections.delete(connection.roomId);
	}

	async refresh<TDocument, TTransaction>(connection: AppServerRoom<TDocument, TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSnapshot<TDocument>> {
		throwIfCancelled(signal);
		const opened = await this.api.open({ roomId: connection.roomId, clientId: connection.clientId, schemaId: connection.schemaId, document: connection.codec.serialize(document), ...(connection.lease === undefined ? {} : { lease: connection.lease }) }).catch(rethrowRoomError);
		throwIfCancelled(signal);
		if (opened.schemaId !== connection.schemaId || opened.clientId !== connection.clientId || opened.snapshot.roomId !== connection.roomId) throw new TypeError('Unexpected collaboration room identity');
		return decodeSnapshot(opened.snapshot, connection.codec);
	}

	async readStatus(connection: AppServerUpdateReceiver & { clientId: string; }, signal: AbortSignal): Promise<RoomStatus> {
		signal.throwIfAborted();
		const status = await this.api.readStatus({ roomId: connection.roomId, clientId: connection.clientId }).catch(rethrowRoomError);
		signal.throwIfAborted();
		if (status.roomId !== connection.roomId) throw new TypeError('Unexpected collaboration room identity');
		return status;
	}

	async submit<TDocument, TTransaction>(connection: AppServerRoom<TDocument, TTransaction>, envelope: RoomEnvelope<TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSubmitOutcome<TTransaction, TDocument>> {
		throwIfCancelled(signal, 'Submitting a Stanza collaboration update was cancelled');
		const submitted = await this.api.submit({
			roomId: connection.roomId,
			clientId: connection.clientId,
			sequence: validateProtocolInteger(envelope.sequence, 'sequence', 1),
			baseVersion: validateProtocolInteger(envelope.baseVersion, 'baseVersion', 0),
			transaction: connection.codec.serializeTransaction(envelope.transaction),
			document: connection.codec.serialize(document),
			...(envelope.epoch === undefined ? {} : { epoch: envelope.epoch }),
		}).catch(rethrowRoomError);
		throwIfCancelled(signal, 'Submitting a Stanza collaboration update was cancelled');
		switch (submitted.status) {
			case 'accepted': return { kind: 'accepted', update: decodeUpdate(submitted.update, connection.codec) };
			case 'conflict': return { kind: 'conflict', updates: Object.freeze(submitted.updates.map(update => decodeUpdate(update, connection.codec))) };
			case 'resync': return { kind: 'resync', snapshot: decodeSnapshot(submitted.snapshot, connection.codec) };
		}
	}

	async updatePresence<TDocument, TTransaction>(connection: AppServerRoom<TDocument, TTransaction>, selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Publishing Stanza collaboration presence was cancelled');
		await this.api.publishPresence({
			roomId: connection.roomId,
			clientId: connection.clientId,
			...(selection === undefined ? {} : { selection: JSON.stringify(selection) }),
		});
		throwIfCancelled(signal, 'Publishing Stanza collaboration presence was cancelled');
	}
}

class AppServerRoom<TDocument = DocumentNode, TTransaction = unknown> extends Disposable implements RejoinableRoom<TDocument, TTransaction> {
	private readonly updateEmitter = this._register(new Emitter<RemoteRoomEnvelope<TTransaction>>());
	private readonly snapshotEmitter = this._register(new Emitter<RoomSnapshot<TDocument>>());
	private readonly presenceEmitter = this._register(new Emitter<readonly RoomPresence[]>());
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private _presenceGeneration = 0;
	private _currentPresence: readonly RoomPresence[] = [];

	readonly onDidReceiveUpdate = this.updateEmitter.event;
	readonly onDidReceiveSnapshot = this.snapshotEmitter.event;
	readonly onDidReceivePresence = this.presenceEmitter.event;
	readonly onDidFail = this.failureEmitter.event;

	constructor(private readonly service: AppServerCollabService, readonly codec: RoomCodec<TDocument, TTransaction>, readonly clientId: string, readonly initialSnapshot: RoomSnapshot<TDocument>, readonly schemaId: string, readonly lease?: boolean) {
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

	get currentPresence(): readonly RoomPresence[] {
		return this._currentPresence;
	}

	readStatus(signal: AbortSignal): Promise<RoomStatus> { signal.throwIfAborted(); return this.service.readStatus(this, signal); }

	refresh(document: TDocument, signal: AbortSignal): Promise<RoomSnapshot<TDocument>> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Collaboration connection is disposed'));
		return this.service.refresh(this, document, signal);
	}

	submit(envelope: RoomEnvelope<TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSubmitOutcome<TTransaction, TDocument>> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Stanza collaboration connection is disposed'));
		return this.service.submit(this, envelope, document, signal);
	}

	updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Stanza collaboration connection is disposed'));
		return this.service.updatePresence(this, selection, signal);
	}

	createInvite(_displayName: string, _role: RoomRole, _signal: AbortSignal): Promise<RoomInvite> {
		return Promise.reject(new Error('The local App Server collaboration authority does not manage remote room members'));
	}

	listMembers(_signal: AbortSignal): Promise<readonly RoomMember[]> {
		return Promise.reject(new Error('The local App Server collaboration authority does not manage remote room members'));
	}

	rotateMemberAccessToken(_principalId: string, _signal: AbortSignal): Promise<RoomInvite> {
		return Promise.reject(new Error('The local App Server collaboration authority does not manage remote room members'));
	}

	revokeMember(_principalId: string, _signal: AbortSignal): Promise<void> {
		return Promise.reject(new Error('The local App Server collaboration authority does not manage remote room members'));
	}

	acceptUpdate(value: AppServerRoomUpdate): void {
		if (this.isDisposed || value.roomId !== this.roomId) return;
		try { this.updateEmitter.fire(decodeUpdate(value, this.codec)); }
		catch (error) { this.failureEmitter.fire(error instanceof Error ? error : new Error(String(error))); }
	}

	acceptPresence(value: AppServerRoomPresenceSnapshot): void {
		if (this.isDisposed || value.roomId !== this.roomId || value.generation < this._presenceGeneration) return;
		const presence = decodePresence(value);
		this._presenceGeneration = presence.generation;
		this._currentPresence = presence.presences.filter(candidate => candidate.clientId !== this.clientId);
		this.presenceEmitter.fire(this._currentPresence);
	}
}

function decodeSnapshot<TDocument, TTransaction>(value: AppServerRoomSnapshot, codec: RoomCodec<TDocument, TTransaction>): RoomSnapshot<TDocument> {
	return Object.freeze({ roomId: value.roomId, epoch: value.epoch ?? undefined, version: validateProtocolInteger(value.version, 'version', 0), document: codec.deserialize(value.document) });
}

function decodeUpdate<TDocument, TTransaction>(value: AppServerRoomUpdate, codec: RoomCodec<TDocument, TTransaction>): RemoteRoomEnvelope<TTransaction> {
	return Object.freeze({
		clientId: value.clientId,
		epoch: value.epoch ?? undefined,
		sequence: validateProtocolInteger(value.sequence, 'sequence', 1),
		baseVersion: validateProtocolInteger(value.baseVersion, 'baseVersion', 0),
		version: validateProtocolInteger(value.version, 'version', 1),
		transaction: codec.deserializeTransaction(value.transaction),
	});
}

function decodePresence(value: AppServerRoomPresenceSnapshot): { readonly generation: number; readonly presences: readonly RoomPresence[]; } {
	return Object.freeze({
		generation: validateProtocolInteger(value.generation, 'presence generation', 0),
		presences: Object.freeze(value.presences.map(presence => Object.freeze({ clientId: presence.clientId, selection: decodeSelection(presence.selection) }))),
	});
}

function decodeSelection(value: string): DocumentSelection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError('Stanza collaboration presence selection must contain JSON');
	}
	const selection = expectRecord(parsed, 'Stanza collaboration presence selection');
	switch (selection.kind) {
		case 'all': return Object.freeze({ kind: 'all' });
		case 'node': return Object.freeze({ kind: 'node', nodeId: expectString(selection.nodeId, 'Stanza collaboration node selection nodeId') });
		case 'text': return Object.freeze({ kind: 'text', anchor: decodePoint(selection.anchor, 'Stanza collaboration text selection anchor'), head: decodePoint(selection.head, 'Stanza collaboration text selection head') });
		default: throw new TypeError('Stanza collaboration presence selection has an unknown kind');
	}
}

function decodePoint(value: unknown, name: string): { readonly nodeId: string; readonly offset: number; } {
	const point = expectRecord(value, name);
	return Object.freeze({ nodeId: expectString(point.nodeId, `${name} nodeId`), offset: validateProtocolInteger(point.offset, `${name} offset`, 0) });
}

function expectRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function expectString(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function validateProtocolInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Stanza collaboration ${name} must be a safe integer greater than or equal to ${minimum}`);
	return value;
}

function rethrowRoomError(error: unknown): never {
	if (error instanceof AppServerRemoteError) {
		const kind = error.message.includes('collab.leaseExpired') ? CollabFailure.Expired : error.message.includes('does not exist') ? CollabFailure.Offline : error.code === -32602 ? CollabFailure.Rejected : CollabFailure.Offline;
		throw new CollabError(kind, error.message);
	}
	throw error;
}
