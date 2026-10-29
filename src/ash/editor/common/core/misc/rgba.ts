/** A compact integer RGBA value used by pixel-oriented editor projections. */
export class RGBA8 {
	_rgba8Brand: void = undefined;
	static readonly Empty = new RGBA8(0, 0, 0, 0);

	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;

	constructor(r: number, g: number, b: number, a: number) {
		this.r = RGBA8._clamp(r);
		this.g = RGBA8._clamp(g);
		this.b = RGBA8._clamp(b);
		this.a = RGBA8._clamp(a);
	}

	equals(other: RGBA8): boolean { return this.r === other.r && this.g === other.g && this.b === other.b && this.a === other.a; }
	static _clamp(value: number): number { return value < 0 ? 0 : value > 255 ? 255 : value | 0; }
}
