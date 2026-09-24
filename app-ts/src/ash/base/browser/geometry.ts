import { Dimension, getWindow, type IDimension } from "./dom.js";

export interface IPosition {
	readonly left: number;
	readonly top: number;
}

export interface IPositionedRectangle extends IPosition, IDimension {}

export function getViewport(targetWindow: Window): IPositionedRectangle {
	const viewport = targetWindow.visualViewport;
	return {
		left: viewport?.offsetLeft ?? 0,
		top: viewport?.offsetTop ?? 0,
		width: viewport?.width ?? targetWindow.innerWidth,
		height: viewport?.height ?? targetWindow.innerHeight,
	};
}

export function getContentSize(element: HTMLElement): Dimension {
	const style = getWindow(element).getComputedStyle(element);
	return new Dimension(
		element.offsetWidth -
			pixels(style.borderLeftWidth) -
			pixels(style.borderRightWidth) -
			pixels(style.paddingLeft) -
			pixels(style.paddingRight),
		element.offsetHeight -
			pixels(style.borderTopWidth) -
			pixels(style.borderBottomWidth) -
			pixels(style.paddingTop) -
			pixels(style.paddingBottom),
	);
}

export function getTotalSize(element: HTMLElement): Dimension {
	const style = getWindow(element).getComputedStyle(element);
	return new Dimension(
		element.offsetWidth +
			pixels(style.marginLeft) +
			pixels(style.marginRight),
		element.offsetHeight +
			pixels(style.marginTop) +
			pixels(style.marginBottom),
	);
}

function pixels(value: string): number {
	return Number.parseFloat(value) || 0;
}
