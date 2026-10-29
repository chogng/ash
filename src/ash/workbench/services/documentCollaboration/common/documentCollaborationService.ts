import type { DocumentCodec } from '../../documentEditor/common/documentCodec.js';
import type { ChannelReference } from '../../../../platform/collab/common/channelService.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentNode } from '../../documentEditor/common/documentCodec.js';
import type { Event } from '../../../../base/common/event.js';
import type { DocumentSelection } from '../../documentEditor/common/documentCodec.js';

export interface DocumentCollaborationSnapshot {
	readonly roomId: string;
	readonly version: number;
	readonly document: DocumentNode;
}
export interface DocumentCollaborationPresence {
	readonly clientId: string;
	readonly selection: DocumentSelection;
}
export interface DocumentCollaborationEnvelope<TTransaction = unknown> {
	readonly clientId: string;
	readonly sequence: number;
	readonly baseVersion: number;
	readonly transaction: TTransaction;
}
export interface DocumentCollaborationRemoteEnvelope<
	TTransaction = unknown,
> extends DocumentCollaborationEnvelope<TTransaction> {
	readonly version: number;
}
export type DocumentCollaborationSubmitOutcome<TTransaction = unknown> =
	| { readonly kind: 'accepted'; readonly update: DocumentCollaborationRemoteEnvelope<TTransaction> }
	| { readonly kind: 'conflict'; readonly updates: readonly DocumentCollaborationRemoteEnvelope<TTransaction>[] }
	| { readonly kind: 'resync'; readonly snapshot: DocumentCollaborationSnapshot };

/** Transactions remain opaque to the transport owner and are decoded by the package codec. */
export interface DocumentCollaborationConnection<TTransaction = unknown> extends IDisposable {
	readonly roomId: string;
	readonly clientId: string;
	readonly canEdit: boolean;
	readonly initialSnapshot: DocumentCollaborationSnapshot;
	readonly currentPresence: readonly DocumentCollaborationPresence[];
	readonly onDidReceiveUpdate: Event<DocumentCollaborationRemoteEnvelope<TTransaction>>;
	readonly onDidReceiveSnapshot: Event<DocumentCollaborationSnapshot>;
	readonly onDidReceivePresence: Event<readonly DocumentCollaborationPresence[]>;
	readonly onDidFail: Event<Error>;
	submit(
		envelope: DocumentCollaborationEnvelope<TTransaction>,
		document: DocumentNode,
		signal: AbortSignal,
	): Promise<DocumentCollaborationSubmitOutcome<TTransaction>>;
	updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void>;
}

/** Inputs needed to create or join one server-ordered Stanza collaboration room. */
export interface DocumentCollaborationOpenInput {
	readonly codec: DocumentCodec;
	readonly roomId?: string;
	readonly clientId: string;
	readonly schemaId: string;
	readonly document: DocumentNode;
	/** An explicit document host selected from the call's shared references. */
	readonly serverUrl?: string;
	readonly channel?: ChannelReference;
}

/** Role assigned to a member invited into a collaboration room. */
export type DocumentCollaborationRoomRole = 'owner' | 'editor' | 'viewer';

/** A newly issued room credential, exposed once to the inviting owner. */
export interface DocumentCollaborationInvite {
	readonly roomId: string;
	readonly principalId: string;
	readonly displayName: string;
	readonly role: DocumentCollaborationRoomRole;
	readonly accessToken: string;
}

/** One active collaboration member visible to a room owner. */
export interface DocumentCollaborationMember {
	readonly principalId: string;
	readonly displayName: string;
	readonly role: DocumentCollaborationRoomRole;
}

/** A room connection with Workbench-owned membership operations. */
export interface DocumentCollaborationRoom extends DocumentCollaborationConnection {
	/** In-process rooms cannot be shared with clients on another host. */
	readonly serverUrl?: string;
	readonly principalId: string | undefined;
	readonly canManageMembers: boolean;
	createInvite(
		displayName: string,
		role: DocumentCollaborationRoomRole,
		signal: AbortSignal,
	): Promise<DocumentCollaborationInvite>;
	listMembers(signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]>;
	rotateMemberAccessToken(principalId: string, signal: AbortSignal): Promise<DocumentCollaborationInvite>;
	revokeMember(principalId: string, signal: AbortSignal): Promise<void>;
}

/** Opens Stanza collaboration rooms and turns transport payloads into schema-valid domain values. */
export interface IDocumentCollaborationService extends IDisposable {
	open(input: DocumentCollaborationOpenInput, signal: AbortSignal): Promise<DocumentCollaborationRoom>;
}
