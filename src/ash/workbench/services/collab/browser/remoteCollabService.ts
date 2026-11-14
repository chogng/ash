import { CollabError, CollabFailure, type RoomStatus } from '../common/collabService.js';
import type { ICollabService, RejoinableRoom } from '../common/collabService.js';
import type { RoomCodec } from '../common/collabService.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
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
import type { RoomEnvelope } from '../common/collabService.js';
import type { RemoteRoomEnvelope } from '../common/collabService.js';

const API_ROOT = '/v1/document-collaboration';
const INITIAL_POLL_RETRY_DELAY_MS = 250;
const MAXIMUM_POLL_RETRY_DELAY_MS = 5_000;

class RemoteCollaborationRequestError extends CollabError {
	constructor(message: string, readonly status: number | undefined) {
		super(message.includes('collab.leaseExpired') ? CollabFailure.Expired : status === 401 || status === 403 ? CollabFailure.Forbidden : message.includes('does not exist') || status === undefined || status === 408 || status === 429 || status >= 500 ? CollabFailure.Offline : CollabFailure.Rejected, message);
	}
}

/** Fetch transport for the independently hosted durable Stanza collaboration service. */
export interface RemoteCollabOptions {
	readonly endpoint: string;
	readonly bearerToken: string;
}

export class RemoteCollabService extends Disposable {
	private readonly connections = new Set<{ dispose(): void; }>();

	constructor() {
		super();
		this._register(toDisposable(() => {
			for (const connection of [...this.connections]) connection.dispose();
		}));
	}

	async open<TDocument, TTransaction>(input: RoomOpenInput<TDocument, TTransaction>, options: RemoteCollabOptions, signal: AbortSignal): Promise<RejoinableRoom<TDocument, TTransaction>> {
		throwIfCancelled(signal, 'Opening a remote Stanza collaboration room was cancelled');
		const target = normalizeTarget(options.endpoint, options.bearerToken);
		const opened = await this.request(target, 'rooms/open', {
			...(input.roomId === undefined ? {} : { roomId: input.roomId }),
			clientId: input.clientId,
			schemaId: input.schemaId,
			document: input.codec.serialize(input.document),
			...(input.lease === undefined ? {} : { lease: input.lease }),
		}, signal);
		throwIfCancelled(signal, 'Opening a remote Stanza collaboration room was cancelled');
		const response = expectRecord(opened, 'remote collaboration open response');
		const snapshot = decodeSnapshot(response.snapshot, input.codec);
		const clientId = expectString(response.clientId, 'remote collaboration clientId');
		if (expectString(response.schemaId, 'remote collaboration schemaId') !== input.schemaId || clientId !== input.clientId || (input.roomId !== undefined && snapshot.roomId !== input.roomId)) throw new TypeError('Unexpected collaboration room identity');
		const principalId = response.principalId === undefined ? undefined : expectString(response.principalId, 'remote collaboration principalId');
		const connection = new RemoteRoom(this, target, input.codec, clientId, principalId, snapshot, input.schemaId, expectBooleanOrDefault(response.canEdit, 'remote collaboration canEdit', true), expectBooleanOrDefault(response.canManageMembers, 'remote collaboration canManageMembers', false), input.lease);
		this.connections.add(connection);
		return connection;
	}

	remove(connection: { dispose(): void; }): void {
		this.connections.delete(connection);
	}

	async refresh<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSnapshot<TDocument>> {
		const opened = expectRecord(await this.request(connection.target, 'rooms/open', {
			roomId: connection.roomId, clientId: connection.clientId, schemaId: connection.schemaId, document: connection.codec.serialize(document), ...(connection.lease === undefined ? {} : { lease: connection.lease }),
		}, signal), 'collaboration refresh response');
		const snapshot = decodeSnapshot(opened.snapshot, connection.codec);
		if (expectString(opened.schemaId, 'remote collaboration schemaId') !== connection.schemaId || expectString(opened.clientId, 'remote collaboration clientId') !== connection.clientId || snapshot.roomId !== connection.roomId) throw new TypeError('Unexpected collaboration room identity');
		return snapshot;
	}

	async readStatus<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, signal: AbortSignal): Promise<RoomStatus> {
		const value = expectRecord(await this.request(connection.target, 'rooms/status', { roomId: connection.roomId, clientId: connection.clientId }, signal), 'room status');
		const roomId = expectString(value.roomId, 'roomId');
		if (roomId !== connection.roomId) throw new TypeError('Unexpected collaboration room identity');
		return { roomId, epoch: expectString(value.epoch, 'epoch'), version: validateProtocolInteger(value.version, 'version', 0), canEdit: expectBooleanOrDefault(value.canEdit, 'canEdit', false) };
	}

	async submit<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, envelope: RoomEnvelope<TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSubmitOutcome<TTransaction, TDocument>> {
		throwIfCancelled(signal, 'Submitting a remote Stanza collaboration update was cancelled');
		const response = expectRecord(await this.request(connection.target, 'rooms/submit', {
			roomId: connection.roomId,
			clientId: connection.clientId,
			sequence: validateProtocolInteger(envelope.sequence, 'sequence', 1),
			baseVersion: validateProtocolInteger(envelope.baseVersion, 'baseVersion', 0),
			transaction: connection.codec.serializeTransaction(envelope.transaction),
			document: connection.codec.serialize(document), ...(envelope.epoch === undefined ? {} : { epoch: envelope.epoch }),
		}, signal), 'remote collaboration submit response');
		throwIfCancelled(signal, 'Submitting a remote Stanza collaboration update was cancelled');
		switch (expectString(response.status, 'remote collaboration submit status')) {
			case 'accepted': return { kind: 'accepted', update: decodeUpdate(response.update, connection.codec) };
			case 'conflict': return { kind: 'conflict', updates: Object.freeze(expectArray(response.updates, 'remote collaboration conflict updates').map(update => decodeUpdate(update, connection.codec))) };
			case 'resync': return { kind: 'resync', snapshot: decodeSnapshot(response.snapshot, connection.codec) };
			default: throw new TypeError('Remote Stanza collaboration returned an unknown submit status');
		}
	}

	async poll<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, signal: AbortSignal): Promise<RemoteReplay<TDocument, TTransaction>> {
		const path = `rooms/${encodeURIComponent(connection.roomId)}/updates?afterVersion=${connection.version}`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), 'remote collaboration updates response');
		switch (expectString(response.status, 'remote collaboration updates status')) {
			case 'updates': return { kind: 'updates', updates: Object.freeze(expectArray(response.updates, 'remote collaboration updates').map(update => decodeUpdate(update, connection.codec))) };
			case 'resync': return { kind: 'resync', snapshot: decodeSnapshot(response.snapshot, connection.codec) };
			default: throw new TypeError('Remote Stanza collaboration returned an unknown updates status');
		}
	}

	async updatePresence<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Publishing remote Stanza collaboration presence was cancelled');
		await this.request(connection.target, 'rooms/presence', {
			roomId: connection.roomId,
			clientId: connection.clientId,
			...(selection === undefined ? {} : { selection: JSON.stringify(selection) }),
		}, signal);
		throwIfCancelled(signal, 'Publishing remote Stanza collaboration presence was cancelled');
	}

	async createInvite<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, displayName: string, role: RoomRole, signal: AbortSignal): Promise<RoomInvite> {
		throwIfCancelled(signal, 'Creating a remote Stanza collaboration invitation was cancelled');
		const response = expectRecord(await this.request(connection.target, 'rooms/invites', {
			roomId: connection.roomId,
			displayName: validateDisplayName(displayName),
			role: validateRoomRole(role),
		}, signal), 'remote collaboration invitation response');
		throwIfCancelled(signal, 'Creating a remote Stanza collaboration invitation was cancelled');
		return decodeInvite(response, connection.roomId);
	}

	async listMembers<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, signal: AbortSignal): Promise<readonly RoomMember[]> {
		throwIfCancelled(signal, 'Reading remote Stanza collaboration members was cancelled');
		const path = `rooms/${encodeURIComponent(connection.roomId)}/members`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), 'remote collaboration members response');
		throwIfCancelled(signal, 'Reading remote Stanza collaboration members was cancelled');
		return Object.freeze(expectArray(response.members, 'remote collaboration members').map(decodeMember));
	}

	async rotateMemberAccessToken<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, principalId: string, signal: AbortSignal): Promise<RoomInvite> {
		throwIfCancelled(signal, 'Rotating a remote Stanza collaboration credential was cancelled');
		const response = expectRecord(await this.request(connection.target, 'rooms/members/rotate-token', {
			roomId: connection.roomId,
			principalId: validatePrincipalId(principalId),
		}, signal), 'remote collaboration credential rotation response');
		throwIfCancelled(signal, 'Rotating a remote Stanza collaboration credential was cancelled');
		return decodeInvite(response, connection.roomId);
	}

	async revokeMember<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, principalId: string, signal: AbortSignal): Promise<void> {
		throwIfCancelled(signal, 'Revoking a remote Stanza collaboration member was cancelled');
		await this.request(connection.target, 'rooms/members/revoke', {
			roomId: connection.roomId,
			principalId: validatePrincipalId(principalId),
		}, signal);
		throwIfCancelled(signal, 'Revoking a remote Stanza collaboration member was cancelled');
	}

	async pollPresence<TDocument, TTransaction>(connection: RemoteRoom<TDocument, TTransaction>, signal: AbortSignal): Promise<RemotePresenceReplay> {
		const path = `rooms/${encodeURIComponent(connection.roomId)}/presence?afterGeneration=${connection.presenceGeneration}`;
		const response = expectRecord(await this.request(connection.target, path, undefined, signal), 'remote collaboration presence response');
		return Object.freeze({
			generation: validateProtocolInteger(response.generation, 'presence generation', 0),
			presences: Object.freeze(expectArray(response.presences, 'remote collaboration presences').map(value => decodePresence(value))),
		});
	}

	private async request(target: RemoteTarget, path: string, body: object | undefined, signal: AbortSignal): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(new URL(`${API_ROOT}/${path}`, target.endpoint), {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					Authorization: `Bearer ${target.bearerToken}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				credentials: 'omit',
				signal,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch (error) {
			throwIfCancelled(signal, 'Remote Stanza collaboration request was cancelled');
			throw new RemoteCollaborationRequestError(`Remote Stanza collaboration is unavailable: ${error instanceof Error ? error.message : 'network request failed'}`, undefined);
		}
		const payload: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const message = payload !== undefined && isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
			throw new RemoteCollaborationRequestError(`Remote Stanza collaboration request failed: ${message}`, response.status);
		}
		return payload;
	}
}

class RemoteRoom<TDocument = DocumentNode, TTransaction = unknown> extends Disposable implements RejoinableRoom<TDocument, TTransaction> {
	private readonly updateEmitter = this._register(new Emitter<RemoteRoomEnvelope<TTransaction>>());
	private readonly snapshotEmitter = this._register(new Emitter<RoomSnapshot<TDocument>>());
	private readonly presenceEmitter = this._register(new Emitter<readonly RoomPresence[]>());
	private readonly failureEmitter = this._register(new Emitter<Error>());
	private polling: AbortController | undefined;
	private presencePolling: AbortController | undefined;
	private readonly presenceHeartbeat: ReturnType<typeof setInterval>;
	private _version: number;
	private _presenceGeneration = 0;
	private _currentPresence: readonly RoomPresence[] = [];
	private presence: DocumentSelection | undefined;

	readonly onDidReceiveUpdate = this.updateEmitter.event;
	readonly onDidReceiveSnapshot = this.snapshotEmitter.event;
	readonly onDidReceivePresence = this.presenceEmitter.event;
	readonly onDidFail = this.failureEmitter.event;
	readonly roomId: string;
	get serverUrl(): string { return this.target.endpoint.origin; }

	constructor(private readonly service: RemoteCollabService, readonly target: RemoteTarget, readonly codec: RoomCodec<TDocument, TTransaction>, readonly clientId: string, readonly principalId: string | undefined, readonly initialSnapshot: RoomSnapshot<TDocument>, readonly schemaId: string, readonly canEdit: boolean, readonly canManageMembers: boolean, readonly lease?: boolean) {
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

	get currentPresence(): readonly RoomPresence[] {
		return this._currentPresence;
	}

	readStatus(signal: AbortSignal): Promise<RoomStatus> { return this.service.readStatus(this, signal); }

	refresh(document: TDocument, signal: AbortSignal): Promise<RoomSnapshot<TDocument>> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Collaboration connection is disposed'));
		return this.service.refresh(this, document, signal);
	}

	submit(envelope: RoomEnvelope<TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSubmitOutcome<TTransaction, TDocument>> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Remote Stanza collaboration connection is disposed'));
		return this.service.submit(this, envelope, document, signal);
	}

	async updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) throw new ReferenceError('Remote Stanza collaboration connection is disposed');
		await this.service.updatePresence(this, selection, signal);
		this.presence = selection;
	}

	createInvite(displayName: string, role: RoomRole, signal: AbortSignal): Promise<RoomInvite> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Remote Stanza collaboration connection is disposed'));
		if (!this.canManageMembers) return Promise.reject(new Error('This collaboration member cannot create room invitations'));
		return this.service.createInvite(this, displayName, role, signal);
	}

	listMembers(signal: AbortSignal): Promise<readonly RoomMember[]> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Remote Stanza collaboration connection is disposed'));
		if (!this.canManageMembers) return Promise.reject(new Error('This collaboration member cannot inspect room members'));
		return this.service.listMembers(this, signal);
	}

	rotateMemberAccessToken(principalId: string, signal: AbortSignal): Promise<RoomInvite> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Remote Stanza collaboration connection is disposed'));
		if (!this.canManageMembers) return Promise.reject(new Error('This collaboration member cannot manage room credentials'));
		return this.service.rotateMemberAccessToken(this, principalId, signal);
	}

	revokeMember(principalId: string, signal: AbortSignal): Promise<void> {
		if (this.isDisposed) return Promise.reject(new ReferenceError('Remote Stanza collaboration connection is disposed'));
		if (!this.canManageMembers) return Promise.reject(new Error('This collaboration member cannot manage room credentials'));
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
				if (replay.kind === 'resync') {
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
				const failure = error instanceof Error ? error : new Error('Remote Stanza collaboration updates failed');
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
				const failure = error instanceof Error ? error : new Error('Remote Stanza collaboration presence updates failed');
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
			if (!this.isDisposed) this.failureEmitter.fire(error instanceof Error ? error : new Error('Remote Stanza collaboration presence heartbeat failed'));
		});
	}
}

interface RemoteTarget {
	readonly endpoint: URL;
	readonly bearerToken: string;
}

type RemoteReplay<TDocument = DocumentNode, TTransaction = unknown> = { readonly kind: 'updates'; readonly updates: readonly RemoteRoomEnvelope<TTransaction>[]; } | { readonly kind: 'resync'; readonly snapshot: RoomSnapshot<TDocument>; };

interface RemotePresenceReplay {
	readonly generation: number;
	readonly presences: readonly RoomPresence[];
}

function normalizeTarget(endpoint: string, bearerToken: string): RemoteTarget {
	let parsed: URL;
	try {
		parsed = new URL(endpoint);
	} catch {
		throw new TypeError('Remote Stanza collaboration endpoint must be an absolute HTTP(S) URL');
	}
	if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new TypeError('Remote Stanza collaboration endpoint must be an HTTP(S) origin without a path, credentials, query, or fragment');
	if (bearerToken.length < 32 || !/^[\x21-\x7e]+$/.test(bearerToken)) throw new TypeError('Remote Stanza collaboration bearer token must contain at least 32 visible ASCII characters');
	return Object.freeze({ endpoint: parsed, bearerToken });
}

function decodeSnapshot<TDocument, TTransaction>(value: unknown, codec: RoomCodec<TDocument, TTransaction>): RoomSnapshot<TDocument> {
	const record = expectRecord(value, 'remote collaboration snapshot');
	return Object.freeze({ epoch: record.epoch === undefined ? undefined : expectString(record.epoch, 'epoch'), roomId: expectString(record.roomId, 'remote collaboration roomId'), version: validateProtocolInteger(record.version, 'version', 0), document: codec.deserialize(expectString(record.document, 'remote collaboration document')) });
}

function decodeUpdate<TDocument, TTransaction>(value: unknown, codec: RoomCodec<TDocument, TTransaction>): RemoteRoomEnvelope<TTransaction> {
	const record = expectRecord(value, 'remote collaboration update');
	return Object.freeze({
		epoch: record.epoch === undefined ? undefined : expectString(record.epoch, 'epoch'), clientId: expectString(record.clientId, 'remote collaboration clientId'),
		sequence: validateProtocolInteger(record.sequence, 'sequence', 1),
		baseVersion: validateProtocolInteger(record.baseVersion, 'baseVersion', 0),
		version: validateProtocolInteger(record.version, 'version', 1),
		transaction: codec.deserializeTransaction(expectString(record.transaction, 'remote collaboration transaction')),
	});
}

function decodePresence(value: unknown): RoomPresence {
	const record = expectRecord(value, 'remote collaboration presence');
	return Object.freeze({
		clientId: expectString(record.clientId, 'remote collaboration presence clientId'),
		selection: decodeSelection(expectString(record.selection, 'remote collaboration presence selection')),
	});
}

function decodeInvite(value: Readonly<Record<string, unknown>>, expectedRoomId: string): RoomInvite {
	const roomId = expectString(value.roomId, 'remote collaboration invitation roomId');
	if (roomId !== expectedRoomId) throw new TypeError('Remote Stanza collaboration invitation belongs to a different room');
	return Object.freeze({
		roomId,
		principalId: expectString(value.principalId, 'remote collaboration invitation principalId'),
		displayName: expectString(value.displayName, 'remote collaboration invitation displayName'),
		role: validateRoomRole(value.role),
		accessToken: expectString(value.accessToken, 'remote collaboration invitation accessToken'),
	});
}

function decodeMember(value: unknown): RoomMember {
	const record = expectRecord(value, 'remote collaboration member');
	return Object.freeze({
		principalId: validatePrincipalId(expectString(record.principalId, 'remote collaboration member principalId')),
		displayName: expectString(record.displayName, 'remote collaboration member displayName'),
		role: validateRoomRole(record.role),
	});
}

function decodeSelection(value: string): DocumentSelection {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new TypeError('Remote Stanza collaboration presence selection must contain JSON');
	}
	const selection = expectRecord(parsed, 'remote collaboration presence selection');
	switch (selection.kind) {
		case 'all': return Object.freeze({ kind: 'all' });
		case 'node': return Object.freeze({ kind: 'node', nodeId: expectString(selection.nodeId, 'remote collaboration node selection nodeId') });
		case 'text': return Object.freeze({ kind: 'text', anchor: decodePoint(selection.anchor, 'remote collaboration text selection anchor'), head: decodePoint(selection.head, 'remote collaboration text selection head') });
		default: throw new TypeError('Remote Stanza collaboration presence selection has an unknown kind');
	}
}

function decodePoint(value: unknown, name: string): { readonly nodeId: string; readonly offset: number; } {
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
	if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function expectBooleanOrDefault(value: unknown, name: string, defaultValue: boolean): boolean {
	if (value === undefined) return defaultValue;
	if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
	return value;
}

function validateDisplayName(value: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('Remote Stanza collaboration invitation display name must be non-empty');
	return value.trim();
}

function validatePrincipalId(value: string): string {
	if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new TypeError("Remote Stanza collaboration member principalId must contain between 1 and 128 letters, numbers, '-' or '_'");
	return value;
}

function validateRoomRole(value: unknown): RoomRole {
	if (value === 'owner' || value === 'editor' || value === 'viewer') return value;
	throw new TypeError('Remote Stanza collaboration invitation role must be owner, editor, or viewer');
}

function validateProtocolInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Stanza collaboration ${name} must be a safe integer greater than or equal to ${minimum}`);
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
			signal.removeEventListener('abort', complete);
			resolve();
		};
		const timeout = setTimeout(complete, delay);
		signal.addEventListener('abort', complete, { once: true });
	});
}
