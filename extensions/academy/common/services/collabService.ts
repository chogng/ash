import type { DocumentTransaction } from '../model/documentTransaction.js';
import type {
	RoomTransport as HostConnection,
	RoomEnvelope as HostEnvelope,
	RemoteRoomEnvelope as HostRemoteEnvelope,
	RoomSubmitOutcome as HostSubmitOutcome,
} from 'ash:editor/workbench/services/collab/common/collabService.js';
export type { RoomSnapshot, RoomPresence } from 'ash:editor/workbench/services/collab/common/collabService.js';

/** Academy specializes opaque host transport values with its validated semantic transaction. */
export type RoomTransport = HostConnection<DocumentTransaction>;
export type RoomEnvelope = HostEnvelope<DocumentTransaction>;
export type RemoteRoomEnvelope = HostRemoteEnvelope<DocumentTransaction>;
export type RoomAcknowledgement = RemoteRoomEnvelope;
export type RoomSubmitOutcome = HostSubmitOutcome<DocumentTransaction>;
