import type { DesignPoint } from './core/geometry.js';

/** Converts viewport CSS pixels to design pixels; devicePixelRatio never enters this transform. */
export class DesignViewport {
	public scale = 1;
	public panX = 0;
	public panY = 0;

	public toWorld(point: DesignPoint): DesignPoint {
		return { x: (point.x - this.panX) / this.scale, y: (point.y - this.panY) / this.scale };
	}

	public panBy(x: number, y: number): void {
		this.panX += x;
		this.panY += y;
	}

	public zoomAt(point: DesignPoint, factor: number): void {
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
}
