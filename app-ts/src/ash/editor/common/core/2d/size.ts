import { type IDimension } from "./dimension.js";

export class Size2D {
	static equals(left: Size2D, right: Size2D): boolean {
		return left.width === right.width && left.height === right.height;
	}

	constructor(
		readonly width: number,
		readonly height: number,
	) {}

	add(other: Size2D): Size2D { return new Size2D(this.width + other.width, this.height + other.height); }
	subtract(other: Size2D): Size2D { return new Size2D(this.width - other.width, this.height - other.height); }
	deltaX(delta: number): Size2D { return new Size2D(this.width + delta, this.height); }
	deltaY(delta: number): Size2D { return new Size2D(this.width, this.height + delta); }
	scale(factor: number): Size2D { return new Size2D(this.width * factor, this.height * factor); }
	scaleWidth(factor: number): Size2D { return new Size2D(this.width * factor, this.height); }
	mapComponents(map: (value: number) => number): Size2D { return new Size2D(map(this.width), map(this.height)); }
	isZero(): boolean { return this.width === 0 && this.height === 0; }
	transpose(): Size2D { return new Size2D(this.height, this.width); }
	toDimension(): IDimension { return { width: this.width, height: this.height }; }
	toString() { return `(${this.width},${this.height})`; }
}
