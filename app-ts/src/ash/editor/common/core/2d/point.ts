export class Point {
	static equals(left: Point, right: Point): boolean {
		return left.x === right.x && left.y === right.y;
	}

	constructor(
		readonly x: number,
		readonly y: number,
	) {}

	add(other: Point): Point { return new Point(this.x + other.x, this.y + other.y); }
	subtract(other: Point): Point { return new Point(this.x - other.x, this.y - other.y); }
	deltaX(delta: number): Point { return new Point(this.x + delta, this.y); }
	deltaY(delta: number): Point { return new Point(this.x, this.y + delta); }
	scale(factor: number): Point { return new Point(this.x * factor, this.y * factor); }
	mapComponents(map: (value: number) => number): Point { return new Point(map(this.x), map(this.y)); }
	isZero(): boolean { return this.x === 0 && this.y === 0; }
	withThreshold(threshold: number): Point { return this.mapComponents(value => Math.abs(value) <= threshold ? 0 : value - Math.sign(value) * threshold); }
	toString() { return `(${this.x},${this.y})`; }
}
