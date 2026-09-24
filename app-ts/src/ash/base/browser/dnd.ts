import { Disposable } from "../common/lifecycle.js";
import { Mimes } from "../common/mime.js";
import { addDisposableListener } from "./dom.js";

export const DataTransfers = {
	RESOURCES: "ResourceURLs",
	DOWNLOAD_URL: "DownloadURL",
	FILES: "Files",
	TEXT: Mimes.text,
	INTERNAL_URI_LIST: "application/vnd.code.uri-list",
} as const;

export interface DragAndDropObserverCallbacks {
	readonly onDragStart?: (event: DragEvent) => void;
	readonly onDrag?: (event: DragEvent) => void;
	readonly onDragEnter?: (event: DragEvent) => void;
	readonly onDragOver?: (event: DragEvent, duration: number) => void;
	readonly onDragLeave?: (event: DragEvent) => void;
	readonly onDrop?: (event: DragEvent) => void;
	readonly onDragEnd?: (event: DragEvent) => void;
}

/**
 * Normalizes nested dragenter/dragleave events for one drop target and owns
 * all native listener registrations.
 */
export class DragAndDropObserver extends Disposable {
	private dragDepth = 0;
	private dragStartedAt: number | undefined;

	constructor(
		readonly element: HTMLElement,
		callbacks: DragAndDropObserverCallbacks,
	) {
		super();
		if (callbacks.onDragStart) {
			this._register(addDisposableListener(element, "dragstart", (event: DragEvent) => {
				callbacks.onDragStart?.(event);
			}));
		}
		if (callbacks.onDrag) {
			this._register(addDisposableListener(element, "drag", (event: DragEvent) => {
				callbacks.onDrag?.(event);
			}));
		}
		this._register(addDisposableListener(element, "dragenter", (event: DragEvent) => {
			this.dragDepth++;
			if (this.dragDepth !== 1) return;
			this.dragStartedAt = event.timeStamp;
			callbacks.onDragEnter?.(event);
		}));
		this._register(addDisposableListener(element, "dragover", (event: DragEvent) => {
			event.preventDefault();
			this.dragStartedAt ??= event.timeStamp;
			callbacks.onDragOver?.(event, event.timeStamp - this.dragStartedAt);
		}));
		this._register(addDisposableListener(element, "dragleave", (event: DragEvent) => {
			this.dragDepth = Math.max(0, this.dragDepth - 1);
			if (this.dragDepth !== 0) return;
			this.dragStartedAt = undefined;
			callbacks.onDragLeave?.(event);
		}));
		this._register(addDisposableListener(element, "drop", (event: DragEvent) => {
			this.dragDepth = 0;
			this.dragStartedAt = undefined;
			callbacks.onDrop?.(event);
		}));
		this._register(addDisposableListener(element, "dragend", (event: DragEvent) => {
			this.dragDepth = 0;
			this.dragStartedAt = undefined;
			callbacks.onDragEnd?.(event);
		}));
	}
}

export function containsDragType(
	event: DragEvent,
	type: string,
): boolean {
	return [...(event.dataTransfer?.types ?? [])].some(
		(candidate) => candidate.toLowerCase() === type.toLowerCase(),
	);
}
