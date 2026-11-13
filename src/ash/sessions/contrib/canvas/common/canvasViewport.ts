import type { CanvasPoint, CanvasBounds } from './canvasGeometry.js';

/** Viewport and world coordinates use CSS pixels; display density does not change the document. */
export class CanvasViewport {
	public scale = 1;
	public panX = 0;
	public panY = 0;

	public toWorld(point: CanvasPoint): CanvasPoint {
		return { x: (point.x - this.panX) / this.scale, y: (point.y - this.panY) / this.scale };
	}

	public panBy(x: number, y: number): void {
		this.panX += x;
		this.panY += y;
	}

	public zoomAt(point: CanvasPoint, factor: number): void {
		const nextScale = Math.min(4, Math.max(0.2, this.scale * factor));
		const world = this.toWorld(point);
		this.panX = point.x - world.x * nextScale;
		this.panY = point.y - world.y * nextScale;
		this.scale = nextScale;
	}

	public reset(): void {
		this.scale = 1;
		this.panX = 0;
		this.panY = 0;
	}

	/** Centers content in the usable area; callers own the insets occupied by their editor controls. */
	public fitBounds(bounds: CanvasBounds, width: number, height: number, padding: CanvasPoint): void {
		this.scale = Math.max(0.2, Math.min(1, (width - 2 * padding.x) / bounds.width, (height - 2 * padding.y) / bounds.height));
		this.panX = width / 2 - (bounds.x + bounds.width / 2) * this.scale;
		this.panY = height / 2 - (bounds.y + bounds.height / 2) * this.scale;
	}
}
