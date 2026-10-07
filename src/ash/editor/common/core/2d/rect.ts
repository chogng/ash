import { BugIndicatingError } from "../../../../base/common/errors.js";
import { OffsetRange } from "../ranges/offsetRange.js";
import { Point } from "./point.js";
import { Size2D } from "./size.js";

export class Rect {
	static fromPoint(point: Point): Rect { return new Rect(point.x, point.y, point.x, point.y); }
	static fromPoints(topLeft: Point, bottomRight: Point): Rect { return new Rect(topLeft.x, topLeft.y, bottomRight.x, bottomRight.y); }
	static fromPointSize(point: Point, size: Point): Rect { return new Rect(point.x, point.y, point.x + size.x, point.y + size.y); }
	static fromLeftTopRightBottom(left: number, top: number, right: number, bottom: number): Rect { return new Rect(left, top, right, bottom); }
	static fromLeftTopWidthHeight(left: number, top: number, width: number, height: number): Rect { return new Rect(left, top, left + width, top + height); }
	static fromRanges(horizontal: OffsetRange, vertical: OffsetRange): Rect { return new Rect(horizontal.start, vertical.start, horizontal.endExclusive, vertical.endExclusive); }

	static hull(rects: Rect[]): Rect {
		if (rects.length === 0) return new Rect(0, 0, 0, 0);
		return rects.slice(1).reduce((hull, rect) => hull.union(rect), rects[0]);
	}

	constructor(
		readonly left: number,
		readonly top: number,
		readonly right: number,
		readonly bottom: number,
	) {
		if (left > right) throw new BugIndicatingError("Invalid arguments: Horizontally offset by " + (left - right));
		if (top > bottom) throw new BugIndicatingError("Invalid arguments: Vertically offset by " + (top - bottom));
	}

	get width() { return this.right - this.left; }
	get height() { return this.bottom - this.top; }

	withMargin(margin: number): Rect;
	withMargin(vertical: number, horizontal: number): Rect;
	withMargin(top: number, right: number, bottom: number, left: number): Rect;
	withMargin(top: number, right?: number, bottom?: number, left?: number): Rect {
		let marginTop: number;
		let marginRight: number;
		let marginBottom: number;
		let marginLeft: number;
		if (right === undefined) {
			marginTop = top;
			marginRight = top;
			marginBottom = top;
			marginLeft = top;
		} else if (bottom === undefined) {
			marginTop = top;
			marginRight = right;
			marginBottom = top;
			marginLeft = right;
		} else {
			marginTop = top;
			marginRight = right;
			marginBottom = bottom;
			marginLeft = left ?? right;
		}
		return new Rect(this.left - marginLeft, this.top - marginTop, this.right + marginRight, this.bottom + marginBottom);
	}

	intersect(parent: Rect): Rect | undefined {
		const left = Math.max(this.left, parent.left);
		const top = Math.max(this.top, parent.top);
		const right = Math.min(this.right, parent.right);
		const bottom = Math.min(this.bottom, parent.bottom);
		return left <= right && top <= bottom ? new Rect(left, top, right, bottom) : undefined;
	}

	intersectHorizontal(range: OffsetRange): Rect { return new Rect(Math.max(this.left, range.start), this.top, Math.max(Math.max(this.left, range.start), Math.min(this.right, range.endExclusive)), this.bottom); }
	intersectVertical(range: OffsetRange): Rect { return new Rect(this.left, Math.max(this.top, range.start), this.right, Math.max(Math.max(this.top, range.start), Math.min(this.bottom, range.endExclusive))); }
	union(other: Rect): Rect { return new Rect(Math.min(this.left, other.left), Math.min(this.top, other.top), Math.max(this.right, other.right), Math.max(this.bottom, other.bottom)); }
	containsRect(other: Rect): boolean { return this.left <= other.left && this.top <= other.top && this.right >= other.right && this.bottom >= other.bottom; }
	containsPoint(point: Point): boolean { return this.left <= point.x && point.x <= this.right && this.top <= point.y && point.y <= this.bottom; }
	moveToBeContainedIn(parent: Rect): Rect {
		const left = clamp(this.left, parent.left, parent.right - this.width);
		const top = clamp(this.top, parent.top, parent.bottom - this.height);
		return new Rect(left, top, left + this.width, top + this.height);
	}
	withWidth(width: number): Rect { return new Rect(this.left, this.top, this.left + width, this.bottom); }
	withHeight(height: number): Rect { return new Rect(this.left, this.top, this.right, this.top + height); }
	withTop(top: number): Rect { return new Rect(this.left, top, this.right, this.bottom); }
	withLeft(left: number): Rect { return new Rect(left, this.top, this.right, this.bottom); }
	translateX(delta: number): Rect { return new Rect(this.left + delta, this.top, this.right + delta, this.bottom); }
	translateY(delta: number): Rect { return new Rect(this.left, this.top + delta, this.right, this.bottom + delta); }
	translate(point: Point): Rect { return this.translateX(point.x).translateY(point.y); }
	deltaRight(delta: number): Rect { return new Rect(this.left, this.top, this.right + delta, this.bottom); }
	deltaTop(delta: number): Rect { return new Rect(this.left, this.top + delta, this.right, this.bottom); }
	deltaLeft(delta: number): Rect { return new Rect(this.left + delta, this.top, this.right, this.bottom); }
	deltaBottom(delta: number): Rect { return new Rect(this.left, this.top, this.right, this.bottom + delta); }
	getLeftTop(): Point { return new Point(this.left, this.top); }
	getRightTop(): Point { return new Point(this.right, this.top); }
	getLeftBottom(): Point { return new Point(this.left, this.bottom); }
	getRightBottom(): Point { return new Point(this.right, this.bottom); }
	getHorizontalRange(): OffsetRange { return new OffsetRange(this.left, this.right); }
	getVerticalRange(): OffsetRange { return new OffsetRange(this.top, this.bottom); }
	withHorizontalRange(range: OffsetRange): Rect { return new Rect(range.start, this.top, range.endExclusive, this.bottom); }
	withVerticalRange(range: OffsetRange): Rect { return new Rect(this.left, range.start, this.right, range.endExclusive); }
	getSize(): Size2D { return new Size2D(this.width, this.height); }
	toStyles() {
		return { position: "absolute", left: `${this.left}px`, top: `${this.top}px`, width: `${this.width}px`, height: `${this.height}px` };
	}
	toString(): string { return `Rect{(${this.left},${this.top}), (${this.right},${this.bottom})}`; }
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}
