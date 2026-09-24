import type { DocumentTransaction } from '../model/documentTransaction.js';
import type { Event } from "../../../base/common/event.js";
import type { IDisposable } from "../../../base/common/lifecycle.js";
import type { DocumentNode } from "../model/document.js";
import type { DocumentSchema } from "../model/documentSchema.js";
import type { DocumentSelection } from "../core/documentSelection.js";

/** Canonical room snapshot supplied after joining or resynchronizing. */
export interface DocumentCollaborationSnapshot {
	readonly roomId: string;
	readonly version: number;
	readonly document: DocumentNode;
}

/** One other collaborator's current ephemeral selection. */
export interface DocumentCollaborationPresence {
	readonly clientId: string;
	readonly selection: DocumentSelection;
}

export type DocumentCollaborationSubmitOutcome =
	| { readonly kind: "accepted"; readonly update: DocumentCollaborationRemoteEnvelope }
	| { readonly kind: "conflict"; readonly updates: readonly DocumentCollaborationRemoteEnvelope[] }
	| { readonly kind: "resync"; readonly snapshot: DocumentCollaborationSnapshot };

/** One lifetime-bound room connection independent of its host transport. */
export interface DocumentCollaborationConnection extends IDisposable {
	readonly roomId: string;
	readonly clientId: string;
	/** Whether this room connection may create document updates. */
	readonly canEdit: boolean;
	readonly schema: DocumentSchema;
	readonly initialSnapshot: DocumentCollaborationSnapshot;
	/** Current remote selections known at connection creation or from later transport events. */
	readonly currentPresence: readonly DocumentCollaborationPresence[];
	readonly onDidReceiveUpdate: Event<DocumentCollaborationRemoteEnvelope>;
	readonly onDidReceiveSnapshot: Event<DocumentCollaborationSnapshot>;
	readonly onDidReceivePresence: Event<readonly DocumentCollaborationPresence[]>;
	readonly onDidFail: Event<Error>;
	submit(envelope: DocumentCollaborationEnvelope, document: DocumentNode, signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome>;
	updatePresence(selection: DocumentSelection | undefined, signal: AbortSignal): Promise<void>;
}

/** One ordered client submission to a Stanza collaboration authority. */
export interface DocumentCollaborationEnvelope {
	readonly clientId: string;
	readonly sequence: number;
	readonly baseVersion: number;
	readonly transaction: DocumentTransaction;
}

/** A server-ordered collaboration submission with its committed document version. */
export interface DocumentCollaborationRemoteEnvelope extends DocumentCollaborationEnvelope {
	readonly version: number;
}

export type DocumentCollaborationAcknowledgement = DocumentCollaborationRemoteEnvelope;
