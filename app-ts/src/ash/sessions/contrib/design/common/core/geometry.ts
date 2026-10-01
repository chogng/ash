export interface DesignPoint {
	readonly x: number;
	readonly y: number;
}

export interface DesignFrame extends DesignPoint {
	readonly width: number;
	readonly height: number;
	/** Clockwise degrees around the frame center. */
	readonly rotation: number;
}

/** Returns pixels relative to the unrotated frame's top-left corner. */
export function toDesignLocal(frame: DesignFrame, point: DesignPoint): DesignPoint {
	const radians = -frame.rotation * Math.PI / 180;
	const dx = point.x - frame.x - frame.width / 2;
	const dy = point.y - frame.y - frame.height / 2;
	return {
		x: dx * Math.cos(radians) - dy * Math.sin(radians) + frame.width / 2,
		y: dx * Math.sin(radians) + dy * Math.cos(radians) + frame.height / 2,
	};
}

export function cubicBezierPoint(start: DesignPoint, outgoing: DesignPoint, incoming: DesignPoint, end: DesignPoint, t: number): DesignPoint {
	const u = 1 - t;
	return {
		x: u ** 3 * start.x + 3 * u ** 2 * t * outgoing.x + 3 * u * t ** 2 * incoming.x + t ** 3 * end.x,
		y: u ** 3 * start.y + 3 * u ** 2 * t * outgoing.y + 3 * u * t ** 2 * incoming.y + t ** 3 * end.y,
	};
}

/** Axis-aligned bounds include the rotated frame of every object. */
export function designBounds(shapes: readonly DesignFrame[]): { x: number; y: number; width: number; height: number } {
	if (shapes.length === 0) { return { x: 0, y: 0, width: 1, height: 1 }; }
	const points = shapes.flatMap(shape => {
		const radians = shape.rotation * Math.PI / 180;
		return [-1, 1].flatMap(x => [-1, 1].map(y => ({
			x: shape.x + shape.width / 2 + x * shape.width / 2 * Math.cos(radians) - y * shape.height / 2 * Math.sin(radians),
			y: shape.y + shape.height / 2 + x * shape.width / 2 * Math.sin(radians) + y * shape.height / 2 * Math.cos(radians),
		})));
	});
	const x = Math.min(...points.map(point => point.x));
	const y = Math.min(...points.map(point => point.y));
	return { x, y, width: Math.max(...points.map(point => point.x)) - x, height: Math.max(...points.map(point => point.y)) - y };
}
