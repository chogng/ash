import { Emitter, type Event } from '../../../base/common/event.js';
import { clamp } from '../../../base/common/numbers.js';

/** Common editor zoom state shared by font construction and host integrations. */
export interface IEditorZoom {
	readonly onDidChangeZoomLevel: Event<number>;
	getZoomLevel(): number;
	setZoomLevel(zoomLevel: number): void;
}

const MIN_ZOOM_LEVEL = -5;
const MAX_ZOOM_LEVEL = 20;

/** Realm-wide editor zoom state, matching VS Code's zoom-level semantics. */
export const EditorZoom: IEditorZoom = new class implements IEditorZoom {
	private zoomLevel = 0;
	private readonly changeEmitter = new Emitter<number>();

	public readonly onDidChangeZoomLevel: Event<number> = this.changeEmitter.event;

	public getZoomLevel(): number {
		return this.zoomLevel;
	}

	public setZoomLevel(zoomLevel: number): void {
		if (typeof zoomLevel !== 'number' || !Number.isFinite(zoomLevel)) {
			throw new TypeError('Editor zoom level must be finite');
		}
		const nextZoomLevel = clamp(zoomLevel, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL);
		if (this.zoomLevel === nextZoomLevel) return;
		this.zoomLevel = nextZoomLevel;
		this.changeEmitter.fire(nextZoomLevel);
	}
};
