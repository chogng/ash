import { clamp } from "../../../common/numbers.js";

export interface ScrollbarAxisMetrics {
	readonly viewportSize: number;
	readonly scrollSize: number;
	readonly position: number;
	readonly maximumPosition: number;
	readonly trackSize: number;
	readonly thumbSize: number;
	readonly thumbPosition: number;
}

export function createScrollbarAxisMetrics(
	viewportSize: number,
	scrollSize: number,
	position: number,
	trackSize: number,
	minimumThumbSize: number,
): ScrollbarAxisMetrics {
	viewportSize = nonNegativeFinite(viewportSize);
	scrollSize = Math.max(viewportSize, nonNegativeFinite(scrollSize));
	const maximumPosition = Math.max(0, scrollSize - viewportSize);
	position = clamp(position, 0, maximumPosition);
	trackSize = nonNegativeFinite(trackSize);
	minimumThumbSize = clamp(
		nonNegativeFinite(minimumThumbSize),
		0,
		trackSize,
	);
	const proportionalSize = scrollSize === 0
		? trackSize
		: trackSize * viewportSize / scrollSize;
	const thumbSize = clamp(proportionalSize, minimumThumbSize, trackSize);
	const thumbTravel = Math.max(0, trackSize - thumbSize);
	const thumbPosition = maximumPosition === 0
		? 0
		: thumbTravel * position / maximumPosition;
	return {
		viewportSize,
		scrollSize,
		position,
		maximumPosition,
		trackSize,
		thumbSize,
		thumbPosition,
	};
}

export function clampScrollbarPosition(
	value: number,
	maximum: number,
): number {
	return clamp(nonNegativeFinite(value), 0, nonNegativeFinite(maximum));
}

function nonNegativeFinite(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}
