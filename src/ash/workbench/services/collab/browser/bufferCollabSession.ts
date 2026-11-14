import { Disposable, MutableDisposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import type { TextModelChange } from '../../../../editor/common/core/textChange.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { localize } from '../../../../nls.js';
import { ICollabService, CollabError, CollabFailure, type RejoinableRoom, type RoomSnapshot, type RemoteRoomEnvelope } from '../common/collabService.js';
import { BufferCollabState as State, type CollabBuffer, type BufferEdit, type BufferCollabProfile } from '../common/bufferCollabService.js';

type Room = RejoinableRoom<Uint8Array, Uint8Array>;
interface Pending { readonly sequence: number; readonly baseVersion: number; readonly epoch: string | undefined; readonly transaction: Uint8Array; readonly document: Uint8Array; readonly generation: number; }

/** Buffer-scoped ordered synchronization; the profile owns CRDT semantics and encoding. */
export class BufferCollabSession extends Disposable {
	private readonly engine: CollabBuffer;
	private authority: CollabBuffer;
	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private room: Room | undefined;
	private epoch: string | undefined;
	private applying = false;
	private version = 0;
	private sequence = 1;
	private generation = 0;
	private acknowledged = 0;
	private pending: Pending | undefined;
	private running = false;
	private queued = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private refreshNeeded = false;
	private retry = 500;
	private lastChange: TextModelChange | undefined;
	private readonly abort = new AbortController();
	private readonly stateEmitter = this._register(new Emitter<State>());
	readonly onDidChangeState = this.stateEmitter.event;
	private _state = State.Connecting;
	get state(): State { return this._state; }
	get roomId(): string | undefined { return this.room?.roomId; }
	get canEdit(): boolean { return !!this.room?.canEdit && this._state !== State.Forbidden; }

	constructor(private readonly model: TextModel, private readonly profile: BufferCollabProfile, private readonly input: { readonly roomId?: string; },
		@ICollabService private readonly service: ICollabService,
		@IDialogService private readonly dialogs: IDialogService,
	) {
		super();
		const random = crypto.getRandomValues(new Uint32Array(2));
		const client = random[0] * 0x20_0000 + (random[1] & 0x1f_ffff) || 1;
		this.engine = this._register(profile.createBuffer(client, input.roomId ? '' : model.getValue()));
		this.authority = profile.createBuffer(1, '');
	}
	private async open(roomId: string | undefined, signal: AbortSignal): Promise<Room> {
		return this.service.open({ codec: this.profile.codec, roomId, schemaId: this.profile.schemaId, clientId: crypto.randomUUID(), document: this.engine.encodeUpdate(), lease: true }, signal);
	}
	private attach(room: Room): void {
		const lifetime = new DisposableStore(); lifetime.add(room);
		this.connection.value = lifetime; this.room = room;
		lifetime.add(room.onDidReceiveUpdate(update => { try { this.receive(update); } catch { this.refreshNeeded = true; this.schedule(0); } }));
		lifetime.add(room.onDidReceiveSnapshot(snapshot => { try { this.snapshot(snapshot); } catch { this.setState(State.Rejected); } }));
		lifetime.add(room.onDidFail(error => this.failure(error)));
	}
	async connect(signal: AbortSignal): Promise<boolean> {
		const initialVersion = this.model.getVersionId();
		const room = await this.open(this.input.roomId, signal);
		if (this.isDisposed || signal.aborted) { room.dispose(); return false; }
		this.attach(room);
		this.engine.applyUpdate(room.initialSnapshot.document);
		this.authority.applyUpdate(room.initialSnapshot.document);
		this.version = room.initialSnapshot.version; this.epoch = room.initialSnapshot.epoch;
		if (this.model.getValue() !== this.engine.source) {
			const confirmation = await this.dialogs.confirm({ message: localize({ bundle: 'ash.collab', key: 'joinReplace' }, 'Replace this document with the shared document?'), detail: localize({ bundle: 'ash.collab', key: 'joinReplaceDetail' }, 'Joining uses the room contents. Cancel to keep the current document.'), primaryButton: localize({ bundle: 'ash.collab', key: 'joinRoom' }, 'Join room') });
			if (!confirmation.confirmed || this.isDisposed || signal.aborted) return false;
		}
		if (this.model.getVersionId() !== initialVersion) throw new Error(localize({ bundle: 'ash.collab', key: 'joinChanged' }, 'The document changed while joining. Try again.'));
		this._register(this.model.registerEditParticipant({
			beforeEdit: edits => {
				if (this.applying) return;
				if (!this.canEdit) throw new Error(localize({ bundle: 'ash.collab', key: 'roomReadOnly' }, 'This collaboration room is read-only.'));
				const values = edits.map(edit => ({ range: { start: edit.startOffset, end: edit.endOffset }, text: edit.text }));
				this.profile.validateSizes(this.engine.preview({ kind: 'edit', edits: values }, this.authority.stateVector()));
				this.engine.apply(values); this.generation++; this.schedule(0);
			},
			canUndo: () => this.canEdit && this.engine.canUndo, canRedo: () => this.canEdit && this.engine.canRedo,
			undo: () => this.history('undo'), redo: () => this.history('redo'),
		}));
		if (this.model.getValue() !== this.engine.source) { this.applying = true; try { this.model.setValue(this.engine.source); } finally { this.applying = false; } }
		this._register(this.model.onDidChangeContent(change => { this.lastChange = change; }));
		this.setState(State.Connected); this.schedule(0);
		return true;
	}
	private history(kind: 'undo' | 'redo'): TextModelChange | undefined {
		if (!this.canEdit || this.isDisposed) return undefined;
		this.profile.validateSizes(this.engine.preview({ kind }, this.authority.stateVector()));
		const edits = this.engine[kind](); if (!edits.length) return undefined;
		this.commit(edits); this.generation++; this.schedule(0); return this.lastChange;
	}
	private commit(edits: readonly BufferEdit[]): void {
		if (!edits.length) return;
		this.applying = true;
		try {
			if (this.engine.source.includes('\n') && this.model.getEOL() !== (this.engine.source.includes('\r\n') ? '\r\n' : '\n')) { this.model.setValue(this.engine.source); return; }
			this.model.applyEdits(edits.map(edit => ({ range: Range.fromPositions(this.model.getPositionAt(edit.range.start), this.model.getPositionAt(edit.range.end)), text: edit.text })));
		} finally { this.applying = false; }
	}
	private receive(update: RemoteRoomEnvelope<Uint8Array>): void {
		if (this.isDisposed) return;
		if (update.epoch && this.epoch && update.epoch !== this.epoch) { this.refreshNeeded = true; this.schedule(0); return; }
		if (update.version <= this.version) return;
		this.authority.applyUpdate(update.transaction); this.commit(this.engine.applyUpdate(update.transaction));
		if (update.version === this.version + 1) this.version = update.version;
		else { this.refreshNeeded = true; this.schedule(0); }
	}
	private snapshot(snapshot: RoomSnapshot<Uint8Array>): void {
		const changedEpoch = snapshot.epoch !== undefined && this.epoch !== undefined && snapshot.epoch !== this.epoch || snapshot.version < this.version;
		if (changedEpoch) {
			// A new authority may have been seeded by another peer. Only its clock is
			// acknowledged; locally retained operations still need a fresh submission.
			this.authority.dispose(); this.authority = this.profile.createBuffer(1, '');
			this.pending = undefined; this.version = snapshot.version; this.generation++;
		}
		this.epoch = snapshot.epoch ?? this.epoch;
		this.authority.applyUpdate(snapshot.document); this.commit(this.engine.applyUpdate(snapshot.document));
		this.version = Math.max(this.version, snapshot.version);
	}
	private setState(state: State): void { if (this._state !== state) { this._state = state; this.stateEmitter.fire(state); } }
	private schedule(delay: number): void {
		if (this.isDisposed) return;
		if (this.running) { this.queued = true; return; }
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = undefined; void this.synchronize(); }, delay);
	}
	private failure(error: unknown): boolean {
		if (error instanceof CollabError && error.kind !== CollabFailure.Offline && error.kind !== CollabFailure.Expired) {
			this.pending = undefined;
			this.setState(error.kind === CollabFailure.Forbidden ? State.Forbidden : State.Rejected);
			if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
			return false;
		}
		this.refreshNeeded = true; this.setState(State.Offline);
		if (!this.running) this.schedule(this.retry);
		return true;
	}
	private async synchronize(): Promise<void> {
		if (!this.room || this.running || this.isDisposed) return;
		this.running = true; this.queued = false;
		let delay: number | undefined = 15000;
		try {
			if (this.refreshNeeded) {
				const snapshot = await this.room.refresh(this.engine.encodeUpdate(), this.abort.signal);
				if (this.isDisposed) return; this.snapshot(snapshot); this.refreshNeeded = false;
			} else if (this.generation === this.acknowledged) {
				const status = await this.room.readStatus(this.abort.signal);
				if (this.isDisposed) return;
				if (!status.canEdit && this.room.canEdit) { this.setState(State.Forbidden); delay = undefined; return; }
				if (status.epoch !== this.epoch || status.version !== this.version) {
					this.snapshot(await this.room.refresh(this.engine.encodeUpdate(), this.abort.signal));
				}
			}
			if (this.canEdit && this.generation > this.acknowledged) {
				// Freeze uncertain requests: an exact retry must preserve both the sequence
				// and original body even when newer local edits have already been applied.
				const packet = this.pending ??= { sequence: this.sequence, baseVersion: this.version, epoch: this.epoch, transaction: this.engine.encodeUpdate(this.authority.stateVector()), document: this.engine.encodeUpdate(), generation: this.generation };
				const result = await this.room.submit({ clientId: this.room.clientId, sequence: packet.sequence, baseVersion: packet.baseVersion, epoch: packet.epoch, transaction: packet.transaction }, packet.document, this.abort.signal);
				if (this.isDisposed) return;
				switch (result.kind) {
					case 'accepted':
						this.authority.applyUpdate(packet.document); this.receive(result.update);
						this.acknowledged = packet.generation; this.sequence++; this.pending = undefined; break;
					case 'conflict': for (const update of result.updates) this.receive(update); this.pending = undefined; break;
					case 'resync': this.snapshot(result.snapshot); this.pending = undefined; break;
				}
				if (this.generation > this.acknowledged) delay = 0;
			}
			this.retry = 500; this.setState(State.Connected);
		} catch (error) {
			if (this.isDisposed) return;
			if (error instanceof CollabError && error.kind === CollabFailure.Expired) {
				try {
					const room = await this.open(this.room!.roomId, this.abort.signal);
					if (this.isDisposed) { room.dispose(); return; }
					this.attach(room); this.snapshot(room.initialSnapshot); this.sequence = 1; this.pending = undefined; this.generation++;
					this.refreshNeeded = false; delay = 0;
				} catch (next) { if (!this.failure(next)) delay = undefined; else delay = this.retry; }
			} else if (!this.failure(error)) delay = undefined;
			else { delay = this.retry; this.retry = Math.min(this.retry * 2, 30000); }
		} finally {
			this.running = false;
			if (delay !== undefined && this._state !== State.Rejected && this._state !== State.Forbidden) this.schedule(this.queued && this._state !== State.Offline ? 0 : delay);
		}
	}
	protected override disposeCore(): void {
		this.abort.abort(); if (this.timer !== undefined) clearTimeout(this.timer);
		this.authority.dispose(); super.disposeCore();
	}
}
