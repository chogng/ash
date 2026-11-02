import type { IObservable, IReader } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ICanvas, ICanvasReference } from '../../../../workbench/contrib/canvases/common/canvas.js';

export const PINNED_CANVAS_PAGE_ID = 'sessions.customView.canvas';
export const MAX_PINNED_CANVASES = 5;

/** Stable provider identity; neither a live browser target nor a source URL is persisted. */
export interface IPinnedCanvasIdentity {
	readonly providerId: string;
	readonly session: URI;
	readonly chat: URI;
	readonly extensionId: string;
	readonly canvasId: string;
	readonly instanceId: string;
}

export const enum PinnedCanvasState { Live = 'live', Pending = 'pending', Unavailable = 'unavailable' }

export interface IPinnedCanvas {
	readonly id: string;
	readonly identity: IPinnedCanvasIdentity;
	readonly reference: IObservable<ICanvasReference | undefined>;
	readonly canvas: IObservable<ICanvas | undefined>;
	readonly title: IObservable<string>;
	readonly chatTitle: IObservable<string | undefined>;
	readonly state: IObservable<PinnedCanvasState>;
	readonly reconnecting: IObservable<boolean>;
}

export type PinnedCanvasTarget = IPinnedCanvas | ICanvasReference;
export const IPinnedCanvasService = createServiceIdentifier<IPinnedCanvasService>('pinnedCanvasService');

export interface IPinnedCanvasService {
	readonly enabled: IObservable<boolean>;
	readonly entries: IObservable<readonly IPinnedCanvas[]>;
	readonly selected: IObservable<IPinnedCanvas | undefined>;
	getEntry(target: PinnedCanvasTarget, reader?: IReader): IPinnedCanvas | undefined;
	isPinned(reference: ICanvasReference, reader?: IReader): boolean;
	isShown(reference: ICanvasReference, reader?: IReader): boolean;
	getTrackedCanvas(reference: ICanvasReference, reader?: IReader): ICanvas | undefined;
	pin(reference: ICanvasReference): boolean;
	unpin(target: PinnedCanvasTarget): void;
	show(target: PinnedCanvasTarget): Promise<void>;
	reconnect(target: PinnedCanvasTarget): Promise<void>;
	goToChat(target: PinnedCanvasTarget): Promise<void>;
	closeCanvas(target: PinnedCanvasTarget): Promise<void>;
}
