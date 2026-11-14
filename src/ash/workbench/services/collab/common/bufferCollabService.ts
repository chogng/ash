import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { Event } from '../../../../base/common/event.js';
import type { TextModel } from '../../../../editor/common/model/textModel.js';
import type { TextModelInput } from '../../textmodelResolver/common/textModelResourceService.js';
import type { RoomCodec } from './collabService.js';

export interface BufferEdit { readonly range: { readonly start: number; readonly end: number; }; readonly text: string; }
export type BufferAction = { readonly kind: 'edit'; readonly edits: readonly BufferEdit[]; } | { readonly kind: 'undo' | 'redo'; };
/** Profile-owned CRDT. All visible edits commit through the existing TextModel. */
export interface CollabBuffer extends IDisposable {
	readonly source: string; readonly canUndo: boolean; readonly canRedo: boolean;
	apply(edits: readonly BufferEdit[]): void;
	applyUpdate(update: Uint8Array): readonly BufferEdit[];
	encodeUpdate(vector?: Uint8Array): Uint8Array;
	stateVector(): Uint8Array;
	preview(action: BufferAction, vector: Uint8Array): { readonly snapshot_bytes: number; readonly update_bytes: number; };
	undo(): readonly BufferEdit[]; redo(): readonly BufferEdit[];
}
export interface BufferCollabProfile {
	readonly schemaId: string;
	readonly codec: RoomCodec<Uint8Array, Uint8Array>;
	createBuffer(client: number, source: string): CollabBuffer;
	validateSizes(sizes: { readonly snapshot_bytes: number; readonly update_bytes: number; }): void;
}
export enum BufferCollabState { Connecting = 'connecting', Connected = 'connected', Offline = 'offline', Rejected = 'rejected', Forbidden = 'forbidden' }
/** Bounded, session-local observations, not a persistent revision or authenticated user history. */
export interface BufferRemoteChange {
	readonly id: number;
	readonly clientId: string | undefined;
	readonly start: number;
	readonly end: number;
	readonly inserted: string;
	readonly removed: string;
}
export interface BufferCollabSession extends IDisposable {
	readonly roomId: string | undefined;
	readonly state: BufferCollabState;
	readonly canEdit: boolean;
	readonly onDidChangeState: Event<BufferCollabState>;
	readonly recentChanges: readonly BufferRemoteChange[];
	readonly onDidChangeRemoteChanges: Event<void>;
}
/** One retained working copy and session per model; panes only observe and invoke. */
export interface IBufferCollabService {
	readonly onDidChange: Event<TextModel>;
	get(model: TextModel): BufferCollabSession | undefined;
	join(model: TextModel, input: TextModelInput, profile: BufferCollabProfile, roomId: string | undefined, signal: AbortSignal): Promise<void>;
	leave(model: TextModel): void;
}
export const IBufferCollabService = createServiceIdentifier<IBufferCollabService>('bufferCollabService');
