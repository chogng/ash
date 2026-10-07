import {
	AbstractScrollbar,
	type AbstractScrollbarOptions,
} from "./abstractScrollbar.js";
import type { ScrollbarAxisMetrics } from "./scrollbarState.js";

/** Vertical track and thumb behavior owned by a scrollable element. */
export class VerticalScrollbar extends AbstractScrollbar {
	constructor(container: HTMLElement, options: AbstractScrollbarOptions) {
		super(container, "vertical", options);
	}

	protected override applyThumbMetrics(
		metrics: ScrollbarAxisMetrics,
	): void {
		this.thumbNode.setHeight(metrics.thumbSize);
		this.thumbNode.setTransform(`translate3d(0, ${metrics.thumbPosition}px, 0)`);
	}

	protected override pointerCoordinate(
		event: Pick<PointerEvent, "clientY">,
	): number {
		return event.clientY;
	}

	protected override trackPointerCoordinate(
		event: Pick<PointerEvent, "clientY">,
		bounds: DOMRect,
	): number {
		return event.clientY - bounds.top;
	}

	protected override keyboardDelta(
		key: string,
		step: number,
	): number | undefined {
		if (key === "ArrowUp") return -step;
		if (key === "ArrowDown") return step;
		return undefined;
	}
}
