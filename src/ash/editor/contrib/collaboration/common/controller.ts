import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { TextModel } from "../../../common/model/textModel.js";
import { TextModelRemoteHistoryPolicy } from "../../../common/model/textModelBlockState.js";
import { serializeDocument } from "../../../common/model/documentSerialization.js";
import type { DocumentCollaborationConnection } from "../../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationPresence } from "../../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationSnapshot } from "../../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationSubmitOutcome } from "../../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationEnvelope } from "../../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../../common/services/documentCollaborationService.js";
import { rebaseDocumentHistory, rebaseDocumentTransaction } from "./rebase.js";
import { DocumentCollaborationSynchronizer } from "./synchronizer.js";
import { DocumentTransaction } from "../../../common/model/documentTransaction.js";

export type DocumentCollaborationState = "connected" | "resyncRequired" | "error";

export interface DocumentCollaborationStateChange {
	readonly state: DocumentCollaborationState;
	readonly roomId: string;
	readonly message?: string;
}

/** Current remote selections projected by one connected collaboration transport. */
export interface DocumentCollaborationPresenceChange {
	readonly presences: readonly DocumentCollaborationPresence[];
}

/** Binds one structured Stanza TextModel to a server-ordered collaboration connection. */
export class DocumentCollaborationController extends Disposable {
	private readonly stateEmitter = this._register(new Emitter<DocumentCollaborationStateChange>());
	private readonly presenceEmitter = this._register(new Emitter<DocumentCollaborationPresenceChange>());
	private readonly synchronizer: DocumentCollaborationSynchronizer;
	private submitting = false;
	private synchronizingModel = false;
	private _presences: readonly DocumentCollaborationPresence[] = [];

	readonly onDidChangeState: Event<DocumentCollaborationStateChange> = this.stateEmitter.event;
	readonly onDidChangePresence: Event<DocumentCollaborationPresenceChange> = this.presenceEmitter.event;

	constructor(private readonly model: TextModel, private readonly connection: DocumentCollaborationConnection) {
		super();
		this.synchronizer = this._register(new DocumentCollaborationSynchronizer({
			schema: model.schema,
			document: connection.initialSnapshot.document,
			clientId: connection.clientId,
			version: connection.initialSnapshot.version,
		}));
		this._presences = connection.currentPresence;
		this._register(connection);
		this._register(model.onDidChangeBlocks(change => {
			if (this.synchronizingModel || (change.origin !== "user" && change.origin !== "undo" && change.origin !== "redo")) return;
			const envelope = this.synchronizer.dispatchLocal(change.transaction);
			if (envelope) this.submit(envelope);
		}));
		this._register(model.onDidChangeSelection(selection => this.publishPresence(selection)));
		this._register(connection.onDidReceiveUpdate(update => this.acceptUpdate(update)));
		this._register(connection.onDidReceiveSnapshot(snapshot => this.acceptResync(snapshot)));
		this._register(connection.onDidReceivePresence(presences => {
			this._presences = presences;
			this.presenceEmitter.fire(Object.freeze({ presences }));
		}));
		this._register(connection.onDidFail(error => this.setState("error", error.message)));
		this.synchronizeModel();
		this.setState("connected");
		this.publishPresence(model.selection);
	}

	get roomId(): string {
		return this.connection.roomId;
	}

	get canEdit(): boolean {
		return this.connection.canEdit;
	}



	get state(): DocumentCollaborationState {
		return this._state;
	}

	get presences(): readonly DocumentCollaborationPresence[] {
		return this._presences;
	}





	private _state: DocumentCollaborationState = "connected";

	private submit(envelope: DocumentCollaborationEnvelope): void {
		if (this.isDisposed || this.submitting || this._state !== "connected") return;
		const document = this.synchronizer.inFlightDocument;
		if (!document || this.synchronizer.inFlight?.sequence !== envelope.sequence) {
			this.setState("error", "The collaboration submission no longer matches the local document state");
			return;
		}
		this.submitting = true;
		void this.connection.submit(envelope, document, new AbortController().signal).then(
			outcome => this.acceptSubmitOutcome(outcome),
			error => this.setState("error", error instanceof Error ? error.message : "Submitting a collaboration update failed"),
		).finally(() => {
			this.submitting = false;
			this.submitNext();
		});
	}

	private publishPresence(selection: TextModel["selection"]): void {
		if (this.isDisposed || this._state !== "connected") return;
		void this.connection.updatePresence(selection, new AbortController().signal).catch(error => {
			if (!this.isDisposed) this.setState("error", error instanceof Error ? error.message : "Publishing collaboration presence failed");
		});
	}

	private acceptSubmitOutcome(outcome: DocumentCollaborationSubmitOutcome): void {
		if (this.isDisposed || this._state !== "connected") return;
		switch (outcome.kind) {
			case "accepted":
				this.acceptUpdate(outcome.update);
				return;
			case "conflict":
				for (const update of outcome.updates) this.acceptUpdate(update);
				return;
			case "resync":
				this.acceptResync(outcome.snapshot);
				return;
		}
	}

	private acceptUpdate(update: DocumentCollaborationRemoteEnvelope): void {
		if (this.isDisposed || this._state !== "connected" || update.version <= this.synchronizer.version) return;
		try {
			if (update.clientId === this.connection.clientId) {
				if (this.synchronizer.inFlight?.sequence !== update.sequence) return;
				this.synchronizer.acknowledge(update);
			} else {
				this.receiveRemoteUpdate(update);
			}
			this.synchronizeModel();
			this.submitNext();
		} catch (error) {
			this.setState("error", error instanceof Error ? error.message : "Applying a collaboration update failed");
		}
	}

	private receiveRemoteUpdate(update: DocumentCollaborationRemoteEnvelope): void {
		const document = this.model.document;
		const remote = documentTransactionOnly(update.transaction);
		const pending = this.synchronizer.pending;
		const canPreserveHistory = serializeDocument(document, this.model.schema) === serializeDocument(this.synchronizer.document, this.model.schema);
		const projection = canPreserveHistory && pending ? rebaseDocumentTransaction(this.synchronizer.canonicalDocument, this.model.schema, remote, pending) : undefined;
		this.synchronizer.receiveRemote(update);
		if (!canPreserveHistory) return;
		if (projection && serializeDocument(projection.document, this.model.schema) !== serializeDocument(this.synchronizer.document, this.model.schema)) return;
		const transaction = projection?.transaction ?? remote;
		if (transaction.steps.length === 0) return;
		this.model.rebaseHistory(entries => rebaseDocumentHistory(document, this.model.schema, entries, transaction));
		this.synchronizingModel = true;
		try {
			this.model.dispatchRemote(transaction, TextModelRemoteHistoryPolicy.Preserve);
		} finally {
			this.synchronizingModel = false;
		}
	}

	private acceptResync(snapshot: DocumentCollaborationSnapshot): void {
		try {
			this.synchronizer.replaceSnapshot(snapshot.document, snapshot.version);
			this.synchronizeModel();
			this.setState("connected");
		} catch (error) {
			this.setState("resyncRequired", error instanceof Error ? error.message : "Local updates require a manual collaboration resync");
		}
	}

	private submitNext(): void {
		if (this.submitting || this._state !== "connected") return;
		const envelope = this.synchronizer.takeNextSubmission();
		if (envelope) this.submit(envelope);
	}

	private synchronizeModel(): void {
		if (serializeDocument(this.model.document, this.model.schema) === serializeDocument(this.synchronizer.document, this.model.schema)) return;
		this.synchronizingModel = true;
		try {
			this.model.resetBlocks(this.synchronizer.document);
		} finally {
			this.synchronizingModel = false;
		}
	}

	private setState(state: DocumentCollaborationState, message?: string): void {
		if (this._state === state && message === undefined) return;
		this._state = state;
		this.stateEmitter.fire(Object.freeze({ state, roomId: this.connection.roomId, ...(message === undefined ? {} : { message }) }));
	}
}

function documentTransactionOnly(transaction: DocumentTransaction): DocumentTransaction {
	return new DocumentTransaction(transaction.steps, { addToHistory: false, label: transaction.label, metadata: transaction.metadata });
}
