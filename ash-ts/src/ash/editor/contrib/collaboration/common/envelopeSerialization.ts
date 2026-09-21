import { isRecord } from "../../../../base/common/types.js";
import { DocumentSerializationError } from "../../../common/model/documentSerialization.js";
import { type DocumentSchema } from "../../../common/model/documentSchema.js";
import { deserializeDocumentTransaction, serializeDocumentTransaction, type SerializedDocumentTransaction } from "../../../common/model/documentTransactionSerialization.js";
import { type DocumentCollaborationEnvelope, type DocumentCollaborationRemoteEnvelope } from "../../../common/services/documentCollaborationService.js";

export const DOCUMENT_COLLABORATION_SERIALIZATION_FORMAT = "ash.document.collaboration";
export const DOCUMENT_COLLABORATION_SERIALIZATION_VERSION = 1;

export interface SerializedDocumentCollaborationEnvelope {
	readonly format: typeof DOCUMENT_COLLABORATION_SERIALIZATION_FORMAT;
	readonly version: typeof DOCUMENT_COLLABORATION_SERIALIZATION_VERSION;
	readonly clientId: string;
	readonly sequence: number;
	readonly baseVersion: number;
	readonly documentVersion?: number;
	readonly transaction: SerializedDocumentTransaction;
}

export type DeserializedDocumentCollaborationEnvelope = DocumentCollaborationEnvelope | DocumentCollaborationRemoteEnvelope;

/** Serializes a collaboration update, including its optional server document version. */
export function serializeDocumentCollaborationEnvelope(envelope: DocumentCollaborationEnvelope | DocumentCollaborationRemoteEnvelope, schema: DocumentSchema): string {
	validateEnvelopeFields(envelope);
	const transaction = JSON.parse(serializeDocumentTransaction(envelope.transaction, schema)) as SerializedDocumentTransaction;
	const payload: SerializedDocumentCollaborationEnvelope = {
		format: DOCUMENT_COLLABORATION_SERIALIZATION_FORMAT,
		version: DOCUMENT_COLLABORATION_SERIALIZATION_VERSION,
		clientId: envelope.clientId,
		sequence: envelope.sequence,
		baseVersion: envelope.baseVersion,
		transaction,
		...(isRemoteEnvelope(envelope) ? { documentVersion: envelope.version } : {}),
	};
	return JSON.stringify(payload);
}

/** Parses and validates a collaboration envelope without trusting transport JSON. */
export function deserializeDocumentCollaborationEnvelope(value: string | unknown, schema: DocumentSchema): DeserializedDocumentCollaborationEnvelope {
	let parsed: unknown = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch (error) {
			throw new DocumentSerializationError("Collaboration envelope JSON is invalid", { cause: error });
		}
	}
	try {
		if (!isRecord(parsed) || parsed.format !== DOCUMENT_COLLABORATION_SERIALIZATION_FORMAT || parsed.version !== DOCUMENT_COLLABORATION_SERIALIZATION_VERSION) throw new DocumentSerializationError("Unsupported collaboration envelope format or version");
		const clientId = requireString(parsed.clientId, "clientId");
		const sequence = requirePositiveInteger(parsed.sequence, "sequence");
		const baseVersion = requireNonNegativeInteger(parsed.baseVersion, "baseVersion");
		const transaction = deserializeDocumentTransaction(parsed.transaction, schema);
		if (parsed.documentVersion === undefined) return Object.freeze({ clientId, sequence, baseVersion, transaction });
		const documentVersion = requirePositiveInteger(parsed.documentVersion, "documentVersion");
		if (documentVersion <= baseVersion) throw new DocumentSerializationError("documentVersion must advance baseVersion");
		return Object.freeze({ clientId, sequence, baseVersion, version: documentVersion, transaction });
	} catch (error) {
		if (error instanceof DocumentSerializationError) throw error;
		throw new DocumentSerializationError("Collaboration envelope failed validation", { cause: error });
	}
}

function validateEnvelopeFields(envelope: DocumentCollaborationEnvelope | DocumentCollaborationRemoteEnvelope): void {
	if (typeof envelope.clientId !== "string" || envelope.clientId.trim().length === 0) throw new TypeError("A collaboration envelope requires a client id");
	if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new RangeError("A collaboration envelope sequence must be a positive safe integer");
	if (!Number.isSafeInteger(envelope.baseVersion) || envelope.baseVersion < 0) throw new RangeError("A collaboration envelope base version must be a non-negative safe integer");
	if (isRemoteEnvelope(envelope) && (!Number.isSafeInteger(envelope.version) || envelope.version <= envelope.baseVersion)) throw new RangeError("A collaboration envelope version must advance its base version");
}

function isRemoteEnvelope(envelope: DocumentCollaborationEnvelope | DocumentCollaborationRemoteEnvelope): envelope is DocumentCollaborationRemoteEnvelope {
	return "version" in envelope;
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new DocumentSerializationError(`${name} must be a non-empty string`);
	return value;
}

function requirePositiveInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DocumentSerializationError(`${name} must be a positive safe integer`);
	return value as number;
}

function requireNonNegativeInteger(value: unknown, name: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) throw new DocumentSerializationError(`${name} must be a non-negative safe integer`);
	return value as number;
}
