import { ScrollbarVisibility as ScrollbarVisibilityOption } from '../../../common/scrollable.js';
import { isFiniteNumber } from "../../../common/numbers.js";

export type ScrollbarVisibility = "auto" | "visible" | "hidden";
export type ScrollDirection = "horizontal" | "vertical" | "both";

export interface ScrollbarWheelOptions {
	/** Multiplier applied after wheel deltas are normalized to CSS pixels. */
	readonly sensitivity?: number;
	/** Multiplier used while Alt is pressed. */
	readonly fastSensitivity?: number;
	/** Whether diagonal input preserves both axes or only its predominant axis. */
	readonly axis?: "both" | "predominant";
	/** Whether Shift converts a vertical-only wheel gesture to horizontal. */
	readonly shift?: "preserve" | "horizontal";
	/** Whether wheel events may propagate when this container cannot move. */
	readonly consume?: "when-scrolling" | "always";
}

interface ScrollableElementBaseOptions {
	readonly ariaLabel?: string;
	/** Page-level tab order position for the container. Defaults to `0`. */
	readonly tabIndex?: number;
	readonly scrollbarSize?: number;
	readonly minimumThumbSize?: number;
	readonly trackClickBehavior?: "jump" | "page";
	readonly wheel?: ScrollbarWheelOptions;
	readonly onScroll?: (
		position: { readonly left: number; readonly top: number },
	) => void;
}

export type ScrollableElementOptions = ScrollableElementBaseOptions & (
	| {
		/** Only horizontal user and programmatic scrolling is allowed. */
		readonly direction: "horizontal";
		readonly horizontal?: ScrollbarVisibility;
		readonly vertical?: never;
	}
	| {
		/** Only vertical user and programmatic scrolling is allowed. */
		readonly direction: "vertical";
		readonly horizontal?: never;
		readonly vertical?: ScrollbarVisibility;
	}
	| {
		/** Both scroll axes are allowed. This is the compatibility default. */
		readonly direction?: "both";
		readonly horizontal?: ScrollbarVisibility;
		readonly vertical?: ScrollbarVisibility;
	}
);

export interface ResolvedScrollableElementOptions {
	readonly direction: ScrollDirection;
	readonly horizontal: ScrollbarVisibility;
	readonly vertical: ScrollbarVisibility;
	readonly scrollbarSize: number;
	readonly minimumThumbSize: number;
	readonly trackClickBehavior: "jump" | "page";
	readonly wheel: {
		readonly sensitivity: number;
		readonly fastSensitivity: number;
		readonly axis: "both" | "predominant";
		readonly shift: "preserve" | "horizontal";
		readonly consume: "when-scrolling" | "always";
	};
}

export function resolveScrollableElementOptions(
	options: ScrollableElementOptions,
): ResolvedScrollableElementOptions {
	const direction = options.direction ?? "both";
	return {
		direction,
		horizontal: direction === "vertical"
			? "hidden"
			: options.horizontal ?? "auto",
		vertical: direction === "horizontal"
			? "hidden"
			: options.vertical ?? "auto",
		scrollbarSize: positiveFinite(options.scrollbarSize, 10),
		minimumThumbSize: positiveFinite(options.minimumThumbSize, 20),
		trackClickBehavior: options.trackClickBehavior ?? "jump",
		wheel: {
			sensitivity: nonNegativeFinite(options.wheel?.sensitivity, 1),
			fastSensitivity: nonNegativeFinite(
				options.wheel?.fastSensitivity,
				5,
			),
			axis: options.wheel?.axis ?? "predominant",
			shift: options.wheel?.shift ?? "horizontal",
			consume: options.wheel?.consume ?? "when-scrolling",
		},
	};
}

function positiveFinite(
	value: number | undefined,
	fallback: number,
): number {
	return isFiniteNumber(value) && value > 0
		? value
		: fallback;
}

function nonNegativeFinite(
	value: number | undefined,
	fallback: number,
): number {
	return isFiniteNumber(value) && value >= 0
		? value
		: fallback;
}

/** Options for a DOM view backed by an existing Scrollable. */
export interface ScrollableElementCreationOptions {
	arrowSize?: number;
	horizontalHasArrows?: boolean;
	verticalHasArrows?: boolean;
	inertialScroll?: boolean;
	lazyRender?: boolean;
	className?: string;
	listenOnDomNode?: HTMLElement;
	horizontal?: ScrollbarVisibilityOption;
	vertical?: ScrollbarVisibilityOption;
	horizontalScrollbarSize?: number;
	verticalScrollbarSize?: number;
	horizontalSliderSize?: number;
	verticalSliderSize?: number;
	scrollByPage?: boolean;
	handleMouseWheel?: boolean;
	alwaysConsumeMouseWheel?: boolean;
	mouseWheelScrollSensitivity?: number;
	fastScrollSensitivity?: number;
	scrollPredominantAxis?: boolean;
	mouseWheelSmoothScroll?: boolean;
}

export type ScrollableElementChangeOptions = Omit<ScrollableElementCreationOptions, 'lazyRender' | 'className' | 'listenOnDomNode'>;
