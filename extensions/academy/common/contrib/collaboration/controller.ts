import type { DocumentNode } from '../../model/document.js';
import { Emitter, type Event } from 'ash:editor/base/common/event.js';
import { Disposable } from 'ash:editor/base/common/lifecycle.js';
import { DocumentTextModel } from '../../model/documentTextModel.js';
import { TextModelRemoteHistoryPolicy } from '../../model/textModelBlockState.js';
import { serializeDocument } from '../../model/documentSerialization.js';
import type { RoomTransport } from '../../services/collabService.js';
import type { RoomPresence } from '../../services/collabService.js';
import type { RoomSnapshot } from '../../services/collabService.js';
import type { RoomSubmitOutcome } from '../../services/collabService.js';
import type { RoomEnvelope } from '../../services/collabService.js';
import type { RemoteRoomEnvelope } from '../../services/collabService.js';
import { rebaseDocumentHistory, rebaseDocumentTransaction } from './rebase.js';
import { CollabSynchronizer } from './synchronizer.js';
import { DocumentTransaction } from '../../model/documentTransaction.js';

export type CollabState = 'connected' | 'resyncRequired' | 'error';

export interface CollabStateChange {
	readonly state: CollabState;
	readonly roomId: string;
	readonly message?: string;
}

/** Current remote selections projected by one connected collaboration transport. */
export interface CollabPresenceChange {
	readonly presences: readonly RoomPresence[];
}

/** Binds one structured Stanza DocumentTextModel to a server-ordered collaboration connection. */
export class CollabController extends Disposable {
	private readonly stateEmitter = this._register(new Emitter<CollabStateChange>());
	private readonly confirmedEmitter = this._register(new Emitter<DocumentNode>());
	/** The exact server-confirmed document, excluding unacknowledged local edits. */
	readonly onDidConfirmDocument = this.confirmedEmitter.event;
	private readonly presenceEmitter = this._register(new Emitter<CollabPresenceChange>());
	private readonly synchronizer: CollabSynchronizer;
	private submitting = false;
	private synchronizingModel = false;
	private _presences: readonly RoomPresence[] = [];

	readonly onDidChangeState: Event<CollabStateChange> = this.stateEmitter.event;
	readonly onDidChangePresence: Event<CollabPresenceChange> = this.presenceEmitter.event;

	constructor(private readonly model: DocumentTextModel, private readonly connection: RoomTransport) {
		super();
		this.synchronizer = this._register(new CollabSynchronizer({
			schema: model.schema,
			document: connection.initialSnapshot.document,
			clientId: connection.clientId,
			version: connection.initialSnapshot.version,
		}));
		this._presences = connection.currentPresence;
		this._register(connection);
		this._register(model.onDidChangeBlocks(change => {
			if (this.synchronizingModel || (change.origin !== 'user' && change.origin !== 'undo' && change.origin !== 'redo')) return;
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
		this._register(connection.onDidFail(error => this.setState('error', error.message)));
		this.synchronizeModel();
		this.setState('connected');
		this.publishPresence(model.selection);
	}

	get roomId(): string {
		return this.connection.roomId;
	}

	get canEdit(): boolean {
		return this._state === 'connected' && this.connection.canEdit;
	}



	/** Preserve the local model while suspending a revoked or changed authorization. */
	invalidate(message: string): void {
		if (this.isDisposed) return;
		this.setState('error', message);
		this.connection.dispose();
	}

	get state(): CollabState {
		return this._state;
	}

	get presences(): readonly RoomPresence[] {
		return this._presences;
	}





	private _state: CollabState = 'connected';

	private submit(envelope: RoomEnvelope): void {
		if (this.isDisposed || this.submitting || this._state !== 'connected') return;
		const document = this.synchronizer.inFlightDocument;
		if (!document || this.synchronizer.inFlight?.sequence !== envelope.sequence) {
			this.setState('error', 'The collaboration submission no longer matches the local document state');
			return;
		}
		this.submitting = true;
		void this.connection.submit(envelope, document, new AbortController().signal).then(
			outcome => this.acceptSubmitOutcome(outcome),
			error => this.setState('error', error instanceof Error ? error.message : 'Submitting a collaboration update failed'),
		).finally(() => {
			this.submitting = false;
			this.submitNext();
		});
	}

	private publishPresence(selection: DocumentTextModel['selection']): void {
		if (this.isDisposed || this._state !== 'connected') return;
		void this.connection.updatePresence(selection, new AbortController().signal).catch(error => {
			if (!this.isDisposed) this.setState('error', error instanceof Error ? error.message : 'Publishing collaboration presence failed');
		});
	}

	private acceptSubmitOutcome(outcome: RoomSubmitOutcome): void {
		if (this.isDisposed || this._state !== 'connected') return;
		switch (outcome.kind) {
			case 'accepted':
				this.acceptUpdate(outcome.update);
				return;
			case 'conflict':
				for (const update of outcome.updates) this.acceptUpdate(update);
				return;
			case 'resync':
				this.acceptResync(outcome.snapshot);
				return;
		}
	}

	private acceptUpdate(update: RemoteRoomEnvelope): void {
		if (this.isDisposed || this._state !== 'connected' || update.version <= this.synchronizer.version) return;
		try {
			if (update.clientId === this.connection.clientId) {
				if (this.synchronizer.inFlight?.sequence !== update.sequence) return;
				this.synchronizer.acknowledge(update);
			} else {
				this.receiveRemoteUpdate(update);
			}
			this.synchronizeModel();
			this.confirmedEmitter.fire(this.synchronizer.canonicalDocument);
			this.submitNext();
		} catch (error) {
			this.setState('error', error instanceof Error ? error.message : 'Applying a collaboration update failed');
		}
	}

	private receiveRemoteUpdate(update: RemoteRoomEnvelope): void {
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

	private acceptResync(snapshot: RoomSnapshot): void {
		try {
			this.synchronizer.replaceSnapshot(snapshot.document, snapshot.version);
			this.synchronizeModel();
			this.setState('connected');
			this.confirmedEmitter.fire(this.synchronizer.canonicalDocument);
		} catch (error) {
			this.setState('resyncRequired', error instanceof Error ? error.message : 'Local updates require a manual collaboration resync');
		}
	}

	private submitNext(): void {
		if (this.submitting || this._state !== 'connected') return;
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

	private setState(state: CollabState, message?: string): void {
		if (this._state === state && message === undefined) return;
		this._state = state;
		this.stateEmitter.fire(Object.freeze({ state, roomId: this.connection.roomId, ...(message === undefined ? {} : { message }) }));
	}
}

function documentTransactionOnly(transaction: DocumentTransaction): DocumentTransaction {
	return new DocumentTransaction(transaction.steps, { addToHistory: false, label: transaction.label, metadata: transaction.metadata });
}
