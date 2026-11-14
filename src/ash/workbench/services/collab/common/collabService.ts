import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ChannelReference } from '../../../../platform/collab/common/channelService.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentNode } from '../../documentEditor/common/documentCodec.js';
import type { Event } from '../../../../base/common/event.js';
import type { DocumentSelection } from '../../documentEditor/common/documentCodec.js';


/** Package-owned payload codec. Transport never constructs an editor model. */
export interface RoomCodec<TDocument, TTransaction> {
	serialize(document: TDocument): string;
	deserialize(value: unknown): TDocument;
	serializeTransaction(transaction: TTransaction): string;
	deserializeTransaction(value: unknown): TTransaction;
}

export interface RoomSnapshot<TDocument = DocumentNode> {
	readonly roomId: string;
	readonly epoch?: string;
	readonly version: number;
	readonly document: TDocument;
}
export interface RoomPresence {
	readonly clientId: string;
	readonly selection: DocumentSelection;
}
export interface RoomEnvelope<TTransaction = unknown> {
	readonly clientId: string;
	readonly sequence: number;
	readonly baseVersion: number;
	readonly epoch?: string;
	readonly transaction: TTransaction;
}
export interface RemoteRoomEnvelope<TTransaction = unknown> extends RoomEnvelope<TTransaction> {
	readonly version: number;
}
export type RoomSubmitOutcome<TTransaction = unknown, TDocument = DocumentNode> =
	| { readonly kind: 'accepted'; readonly update: RemoteRoomEnvelope<TTransaction>; }
	| { readonly kind: 'conflict'; readonly updates: readonly RemoteRoomEnvelope<TTransaction>[]; }
	| { readonly kind: 'resync'; readonly snapshot: RoomSnapshot<TDocument>; };

/** Transactions remain opaque to the transport owner and are decoded by the package codec. */
export interface RoomTransport<TTransaction = unknown, TDocument = DocumentNode> extends IDisposable {
	readonly roomId: string;
	readonly clientId: string;
	readonly canEdit: boolean;
	readonly initialSnapshot: RoomSnapshot<TDocument>;
	readonly currentPresence: readonly RoomPresence[];
	readonly onDidReceiveUpdate: Event<RemoteRoomEnvelope<TTransaction>>;
	readonly onDidReceiveSnapshot: Event<RoomSnapshot<TDocument>>;
	readonly onDidReceivePresence: Event<readonly RoomPresence[]>;
	readonly onDidFail: Event<Error>;
	submit(envelope: RoomEnvelope<TTransaction>, document: TDocument, signal: AbortSignal): Promise<RoomSubmitOutcome<TTransaction, TDocument>>;
	updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void>;
}

/** Inputs needed to create or join one server-ordered Stanza collaboration room. */
export interface RoomOpenInput<TDocument = DocumentNode, TTransaction = unknown> {
	readonly codec: RoomCodec<TDocument, TTransaction>;
	readonly roomId?: string;
	readonly clientId: string;
	readonly schemaId: string;
	readonly lease?: boolean;
	readonly document: TDocument;
	/** An explicit document host selected from the call's shared references. */
	readonly serverUrl?: string;
	readonly channel?: ChannelReference;
}

/** Role assigned to a member invited into a collaboration room. */
export type RoomRole = 'owner' | 'editor' | 'viewer';

/** A newly issued room credential, exposed once to the inviting owner. */
export interface RoomInvite {
	readonly roomId: string;
	readonly principalId: string;
	readonly displayName: string;
	readonly role: RoomRole;
	readonly accessToken: string;
}

/** One active collaboration member visible to a room owner. */
export interface RoomMember {
	readonly principalId: string;
	readonly displayName: string;
	readonly role: RoomRole;
}

/** A room connection with Workbench-owned membership operations. */
export interface Room<TDocument = DocumentNode, TTransaction = unknown> extends RoomTransport<TTransaction, TDocument> {
	/** In-process rooms cannot be shared with clients on another host. */
	readonly serverUrl?: string;
	readonly principalId: string | undefined;
	readonly canManageMembers: boolean;
	createInvite(displayName: string, role: RoomRole, signal: AbortSignal): Promise<RoomInvite>;
	listMembers(signal: AbortSignal): Promise<readonly RoomMember[]>;
	rotateMemberAccessToken(principalId: string, signal: AbortSignal): Promise<RoomInvite>;
	revokeMember(principalId: string, signal: AbortSignal): Promise<void>;
}

/** Opens Stanza collaboration rooms and turns transport payloads into schema-valid domain values. */
export interface IDocumentRoomService extends IDisposable {
	open(input: RoomOpenInput, signal: AbortSignal): Promise<Room>;
}

/** A package payload room that can rejoin after transport recovery. */
export interface RejoinableRoom<TDocument, TTransaction> extends Room<TDocument, TTransaction> {
	readStatus(signal: AbortSignal): Promise<RoomStatus>;
	refresh(document: TDocument, signal: AbortSignal): Promise<RoomSnapshot<TDocument>>;
}
/** Shared transport for schema-owned document payloads, independent of editor models. */
export interface ICollabService extends IDisposable {
	open<TDocument, TTransaction>(input: RoomOpenInput<TDocument, TTransaction>, signal: AbortSignal): Promise<RejoinableRoom<TDocument, TTransaction>>;
}
export const ICollabService = createServiceIdentifier<ICollabService>('collabService');

export interface RoomStatus { readonly roomId: string; readonly epoch: string; readonly version: number; readonly canEdit: boolean; }
export enum CollabFailure { Offline = 'offline', Rejected = 'rejected', Forbidden = 'forbidden', Expired = 'expired' }
export class CollabError extends Error { constructor(readonly kind: CollabFailure, message: string) { super(message); this.name = 'CollabError'; } }
