/**
 * Compatibility exports for the former combined scrollbar/container API.
 *
 * New code should name `ScrollableElement` directly. A scrollbar is one axis
 * owned by that container rather than the container itself.
 */
export {
	ScrollableElement,
	ScrollableElement as Scrollbar,
} from "./scrollableElement.js";
export type {
	ScrollableElementOptions,
	ScrollableElementOptions as ScrollbarOptions,
	ScrollableElementState,
	ScrollableElementState as ScrollbarState,
	ScrollableScrollEvent,
	ScrollableScrollEvent as ScrollbarScrollEvent,
	ScrollDirection,
	ScrollPosition,
	ScrollPosition as ScrollbarPosition,
	ScrollbarVisibility,
	ScrollbarWheelOptions,
} from "./scrollableElement.js";
export type { ScrollbarAxis } from "./abstractScrollbar.js";
