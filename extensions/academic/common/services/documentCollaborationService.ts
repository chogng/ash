import type { DocumentTransaction } from '../model/documentTransaction.js';
import type {
	DocumentCollaborationConnection as HostConnection,
	DocumentCollaborationEnvelope as HostEnvelope,
	DocumentCollaborationRemoteEnvelope as HostRemoteEnvelope,
	DocumentCollaborationSubmitOutcome as HostSubmitOutcome,
} from 'ash:editor/workbench/services/documentCollaboration/common/documentCollaborationService.js';
export type { DocumentCollaborationSnapshot, DocumentCollaborationPresence } from 'ash:editor/workbench/services/documentCollaboration/common/documentCollaborationService.js';

/** Academy specializes opaque host transport values with its validated semantic transaction. */
export type DocumentCollaborationConnection = HostConnection<DocumentTransaction>;
export type DocumentCollaborationEnvelope = HostEnvelope<DocumentTransaction>;
export type DocumentCollaborationRemoteEnvelope = HostRemoteEnvelope<DocumentTransaction>;
export type DocumentCollaborationAcknowledgement = DocumentCollaborationRemoteEnvelope;
export type DocumentCollaborationSubmitOutcome = HostSubmitOutcome<DocumentTransaction>;
