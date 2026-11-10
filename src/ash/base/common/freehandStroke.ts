export interface FreehandPoint { readonly x: number; readonly y: number; }

/** Samples a pen stroke in the caller's coordinate space. */
export class FreehandStroke {
	private readonly samples: FreehandPoint[];
	get points(): readonly FreehandPoint[] { return this.samples; }

	constructor(start: FreehandPoint, private readonly spacing = 2) {
		this.samples = [start];
	}

	append(point: FreehandPoint): boolean {
		const last = this.samples[this.samples.length - 1];
		if (Math.hypot(point.x - last.x, point.y - last.y) < this.spacing) return false;
		this.samples.push(point);
		return true;
	}
}
