import {
	AbstractScrollbar,
	type AbstractScrollbarOptions,
} from "./abstractScrollbar.js";
import type { ScrollbarAxisMetrics } from "./scrollbarState.js";

/** Horizontal track and thumb behavior owned by a scrollable element. */
export class HorizontalScrollbar extends AbstractScrollbar {
	constructor(container: HTMLElement, options: AbstractScrollbarOptions) {
		super(container, "horizontal", options);
	}

	protected override applyThumbMetrics(
		metrics: ScrollbarAxisMetrics,
	): void {
		this.thumbNode.setWidth(metrics.thumbSize);
		this.thumbNode.setTransform(`translate3d(${metrics.thumbPosition}px, 0, 0)`);
	}

	protected override pointerCoordinate(
		event: Pick<PointerEvent, "clientX">,
	): number {
		return event.clientX;
	}

	protected override trackPointerCoordinate(
		event: Pick<PointerEvent, "clientX">,
		bounds: DOMRect,
	): number {
		return event.clientX - bounds.left;
	}

	protected override keyboardDelta(
		key: string,
		step: number,
	): number | undefined {
		if (key === "ArrowLeft") return -step;
		if (key === "ArrowRight") return step;
		return undefined;
	}
}
