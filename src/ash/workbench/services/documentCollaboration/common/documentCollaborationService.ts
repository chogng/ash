import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentNode } from '../../../../editor/common/model/document.js';
import type { DocumentSchema } from '../../../../editor/common/model/documentSchema.js';
import type { DocumentCollaborationConnection } from '../../../../editor/common/services/documentCollaborationService.js';

/** Inputs needed to create or join one server-ordered Stanza collaboration room. */
export interface DocumentCollaborationOpenInput {
	readonly roomId?: string;
	readonly clientId: string;
	readonly schemaId: string;
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
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
	readonly principalId: string | undefined;
	readonly canManageMembers: boolean;
	createInvite(displayName: string, role: DocumentCollaborationRoomRole, signal: AbortSignal): Promise<DocumentCollaborationInvite>;
	listMembers(signal: AbortSignal): Promise<readonly DocumentCollaborationMember[]>;
	rotateMemberAccessToken(principalId: string, signal: AbortSignal): Promise<DocumentCollaborationInvite>;
	revokeMember(principalId: string, signal: AbortSignal): Promise<void>;
}

/** Opens Stanza collaboration rooms and turns transport payloads into schema-valid domain values. */
export interface IDocumentCollaborationService extends IDisposable {
	open(input: DocumentCollaborationOpenInput, signal: AbortSignal): Promise<DocumentCollaborationRoom>;
}
