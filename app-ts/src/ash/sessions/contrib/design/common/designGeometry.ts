import type { DesignPoint, DesignShape } from './designDocument.js';

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

/** Inverse rotation makes hit testing agree with SVG rendering, including ellipse corners. */
export function hitTestDesignShapes(shapes: readonly DesignShape[], point: DesignPoint): DesignShape | undefined {
	for (let index = shapes.length - 1; index >= 0; index--) {
		const shape = shapes[index];
		const radians = -shape.rotation * Math.PI / 180;
		const dx = point.x - shape.x - shape.width / 2;
		const dy = point.y - shape.y - shape.height / 2;
		const x = dx * Math.cos(radians) - dy * Math.sin(radians);
		const y = dx * Math.sin(radians) + dy * Math.cos(radians);
		const inside = shape.kind === 'ellipse'
			? (x / (shape.width / 2)) ** 2 + (y / (shape.height / 2)) ** 2 <= 1
			: Math.abs(x) <= shape.width / 2 && Math.abs(y) <= shape.height / 2;
		if (inside) {
			return shape;
		}
	}
	return undefined;
}
