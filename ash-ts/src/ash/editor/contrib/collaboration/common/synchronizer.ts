import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { validateDocumentSelection } from "../../../common/core/documentSelection.js";
import { freezeDocumentNode, type DocumentNode } from "../../../common/model/document.js";
import { DocumentSchema } from "../../../common/model/documentSchema.js";
import { applyDocumentTransaction, DocumentTransaction, type DocumentStep } from "../../../common/model/documentTransaction.js";
import type { DocumentCollaborationAcknowledgement, DocumentCollaborationEnvelope, DocumentCollaborationRemoteEnvelope } from "../../../common/services/documentCollaborationService.js";
import { rebaseDocumentTransaction } from "./rebase.js";

export interface DocumentCollaborationSynchronizerOptions {
	readonly schema: DocumentSchema;
	readonly document: DocumentNode;
	readonly clientId: string;
	readonly version?: number;
}

export interface DocumentCollaborationSynchronizationChange {
	readonly kind: "local" | "remote" | "acknowledged";
	readonly document: DocumentNode;
	readonly canonicalDocument: DocumentNode;
	readonly pending: DocumentTransaction | undefined;
	readonly envelope: DocumentCollaborationEnvelope;
	readonly droppedSteps: readonly DocumentStep[];
}

/**
 * Synchronizes one ordered server submission with a locally optimistic buffer.
 *
 * A client never blocks typing for network I/O: the first local transaction is
 * in flight, later transactions are buffered, and remote updates rebase the
 * combined local intent before the next submission is issued.
 */
export class DocumentCollaborationSynchronizer extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<DocumentCollaborationSynchronizationChange>());
	private _canonicalDocument: DocumentNode;
	private _document: DocumentNode;
	private _inFlight: DocumentCollaborationEnvelope | undefined;
	private _buffer: DocumentTransaction | undefined;
	private _version: number;
	private _sequence = 0;

	readonly onDidChange: Event<DocumentCollaborationSynchronizationChange> = this.changeEmitter.event;

	constructor(options: DocumentCollaborationSynchronizerOptions) {
		super();
		if (typeof options.clientId !== "string" || options.clientId.trim().length === 0) throw new TypeError("A collaboration client id is required");
		const version = options.version ?? 0;
		if (!Number.isSafeInteger(version) || version < 0) throw new RangeError("A collaboration document version must be a non-negative safe integer");
		const document = freezeDocumentNode(options.document);
		options.schema.validate(document);
		this.schema = options.schema;
		this._canonicalDocument = document;
		this._document = document;
		this._version = version;
		this.clientId = options.clientId;
	}

	readonly schema: DocumentSchema;

	readonly clientId: string;

	get document(): DocumentNode {
		this.assertNotDisposed();
		return this._document;
	}

	get canonicalDocument(): DocumentNode {
		this.assertNotDisposed();
		return this._canonicalDocument;
	}

	get version(): number {
		this.assertNotDisposed();
		return this._version;
	}

	/** All local intent not yet represented by the canonical server snapshot. */
	get pending(): DocumentTransaction | undefined {
		this.assertNotDisposed();
		return composeTransactions(this._inFlight?.transaction, this._buffer);
	}

	/** The exact envelope currently awaiting an ordered collaboration result. */
	get inFlight(): DocumentCollaborationEnvelope | undefined {
		this.assertNotDisposed();
		return this._inFlight;
	}

	/** Snapshot produced by the exact in-flight update, excluding later local typing. */
	get inFlightDocument(): DocumentNode | undefined {
		this.assertNotDisposed();
		return this._inFlight ? applySynchronizerTransaction(this._canonicalDocument, this.schema, this._inFlight.transaction).document : undefined;
	}

	get pendingSequence(): number | undefined {
		this.assertNotDisposed();
		return this._inFlight?.sequence;
	}

	/** Applies a local transaction optimistically and returns an immediately sendable envelope when idle. */
	dispatchLocal(transaction: DocumentTransaction): DocumentCollaborationEnvelope | undefined {
		this.assertNotDisposed();
		const applied = applySynchronizerTransaction(this._document, this.schema, transaction);
		this._document = applied.document;
		if (transaction.steps.length === 0) return undefined;
		if (this._inFlight) {
			this._buffer = composeTransactions(this._buffer, transaction);
			return undefined;
		}
		const envelope = this.beginSubmission(transaction);
		this.emitChange({ kind: "local", envelope, droppedSteps: [] });
		return envelope;
	}

	/** Returns the buffered local transaction once the preceding server submission has settled. */
	takeNextSubmission(): DocumentCollaborationEnvelope | undefined {
		this.assertNotDisposed();
		if (this._inFlight || !this._buffer) return undefined;
		const envelope = this.beginSubmission(this._buffer);
		this._buffer = undefined;
		this.emitChange({ kind: "local", envelope, droppedSteps: [] });
		return envelope;
	}

	/** Applies a server-ordered remote update and rebases every unsent local change. */
	receiveRemote(envelope: DocumentCollaborationRemoteEnvelope): DocumentCollaborationSynchronizationChange {
		this.assertNotDisposed();
		this.validateRemoteEnvelope(envelope);
		if (envelope.clientId === this.clientId) throw new DocumentCollaborationError("A local update must be acknowledged, not received as remote");
		const remote = applySynchronizerTransaction(this._canonicalDocument, this.schema, envelope.transaction);
		const local = this.pending;
		const rebased = local ? rebaseDocumentTransaction(this._canonicalDocument, this.schema, local, envelope.transaction) : undefined;
		this._canonicalDocument = remote.document;
		this._document = rebased?.document ?? remote.document;
		this._inFlight = undefined;
		this._buffer = rebased && rebased.transaction.steps.length > 0 ? rebased.transaction : undefined;
		this._version = envelope.version;
		return this.emitChange({ kind: "remote", envelope, droppedSteps: rebased?.droppedSteps ?? [] });
	}

	/** Commits the exact server-accepted in-flight transaction while retaining later local input. */
	acknowledge(envelope: DocumentCollaborationAcknowledgement): DocumentCollaborationSynchronizationChange {
		this.assertNotDisposed();
		this.validateRemoteEnvelope(envelope);
		if (envelope.clientId !== this.clientId) throw new DocumentCollaborationError("Only the local client can acknowledge its own update");
		if (!this._inFlight || envelope.sequence !== this._inFlight.sequence) throw new DocumentCollaborationError("The acknowledgement does not match the current in-flight update");
		const committed = applySynchronizerTransaction(this._canonicalDocument, this.schema, envelope.transaction);
		this._canonicalDocument = committed.document;
		this._version = envelope.version;
		this._inFlight = undefined;
		this._document = this._buffer ? applySynchronizerTransaction(committed.document, this.schema, this._buffer).document : committed.document;
		return this.emitChange({ kind: "acknowledged", envelope, droppedSteps: [] });
	}

	/** Replaces the canonical snapshot only when no local intent would be lost. */
	replaceSnapshot(document: DocumentNode, version: number): void {
		this.assertNotDisposed();
		if (this.pending) throw new DocumentCollaborationError("Cannot replace a collaboration snapshot while local updates are pending");
		if (!Number.isSafeInteger(version) || version < 0) throw new RangeError("A collaboration document version must be a non-negative safe integer");
		const normalized = freezeDocumentNode(document);
		this.schema.validate(normalized);
		this._canonicalDocument = normalized;
		this._document = normalized;
		this._version = version;
	}

	private beginSubmission(transaction: DocumentTransaction): DocumentCollaborationEnvelope {
		this._sequence += 1;
		const envelope = Object.freeze({ clientId: this.clientId, sequence: this._sequence, baseVersion: this._version, transaction });
		this._inFlight = envelope;
		return envelope;
	}

	private validateRemoteEnvelope(envelope: DocumentCollaborationRemoteEnvelope): void {
		if (!envelope || typeof envelope !== "object") throw new TypeError("A collaboration envelope is required");
		if (typeof envelope.clientId !== "string" || envelope.clientId.trim().length === 0) throw new TypeError("A collaboration envelope requires a client id");
		if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new RangeError("A collaboration envelope sequence must be a positive safe integer");
		if (!Number.isSafeInteger(envelope.baseVersion) || envelope.baseVersion !== this._version) throw new DocumentCollaborationError(`Collaboration update is based on version ${envelope.baseVersion}, expected ${this._version}`);
		if (!Number.isSafeInteger(envelope.version) || envelope.version <= envelope.baseVersion) throw new DocumentCollaborationError("A collaboration update must advance the document version");
		if (!(envelope.transaction instanceof DocumentTransaction)) throw new TypeError("A collaboration envelope requires a Stanza transaction");
	}

	private emitChange(options: { readonly kind: DocumentCollaborationSynchronizationChange["kind"]; readonly envelope: DocumentCollaborationEnvelope; readonly droppedSteps: readonly DocumentStep[] }): DocumentCollaborationSynchronizationChange {
		const change = Object.freeze({ kind: options.kind, document: this._document, canonicalDocument: this._canonicalDocument, pending: this.pending, envelope: options.envelope, droppedSteps: Object.freeze([...options.droppedSteps]) });
		this.changeEmitter.fire(change);
		return change;
	}

}

export class DocumentCollaborationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "DocumentCollaborationError";
	}
}

function applySynchronizerTransaction(document: DocumentNode, schema: DocumentSchema, transaction: DocumentTransaction): { readonly document: DocumentNode } {
	const applied = applyDocumentTransaction(document, schema, transaction);
	if (transaction.selection) validateDocumentSelection(applied.document, transaction.selection);
	return applied;
}

function composeTransactions(first: DocumentTransaction | undefined, second: DocumentTransaction | undefined): DocumentTransaction | undefined {
	if (!first) return second;
	if (!second) return first;
	return new DocumentTransaction([...first.steps, ...second.steps], {
		addToHistory: first.addToHistory && second.addToHistory,
		label: second.label,
		selection: second.selection,
		selectionSet: second.selectionSet,
		storedMarks: second.storedMarks,
		storedMarksSet: second.storedMarksSet,
		historyGroup: second.historyGroup,
		metadata: [...first.metadata, ...second.metadata],
	});
}
