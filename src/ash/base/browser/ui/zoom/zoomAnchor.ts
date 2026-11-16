import { clamp } from '../../../common/numbers.js';

/** Projects one zoom axis around a viewport point while respecting centered content and edge insets. */
export class ZoomAnchor {
	public readonly viewport: number;
	public readonly scroll: number;
	private readonly start: number;
	private readonly insetStart: number;
	private readonly insetEnd: number;
	private size: number;
	private offset: number;

	constructor(layout: { readonly viewport: number; readonly scroll: number; readonly size: number; readonly insetStart?: number; readonly insetEnd?: number; }) {
		this.viewport = layout.viewport;
		this.scroll = layout.scroll;
		this.insetStart = layout.insetStart ?? 0;
		this.insetEnd = layout.insetEnd ?? 0;
		this.size = layout.size;
		this.start = this.origin - this.scroll;
		this.offset = this.start;
	}

	public get position(): number { return this.offset; }
	public get translation(): number { return this.offset - this.start; }
	public get scrollPosition(): number { return Math.max(0, this.origin - this.offset); }

	private get origin(): number {
		return this.insetStart + Math.max(0, (this.viewport - this.insetStart - this.insetEnd - this.size) / 2);
	}

	public zoomAround(anchor: number, size: number): void {
		const ratio = size / this.size;
		this.size = size;
		this.offset = size + this.insetStart + this.insetEnd <= this.viewport
			? this.origin
			: clamp(anchor + (this.offset - anchor) * ratio, this.viewport - this.insetEnd - size, this.insetStart);
	}
}
