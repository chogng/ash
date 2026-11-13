export interface IScreenshotRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Edge rounding keeps reverse drags and mixed display scales on one image-pixel grid. */
export function screenshotRectangle(start: { readonly x: number; readonly y: number; }, end: { readonly x: number; readonly y: number; }): IScreenshotRect {
	const x = Math.round(Math.min(start.x, end.x));
	const y = Math.round(Math.min(start.y, end.y));
	return {
		x,
		y,
		width: Math.max(1, Math.round(Math.max(start.x, end.x)) - x),
		height: Math.max(1, Math.round(Math.max(start.y, end.y)) - y)
	};
}

export function clampScreenshotRectangle(rect: IScreenshotRect, width: number, height: number): IScreenshotRect {
	const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
	const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(width - x, Math.round(rect.width))),
		height: Math.max(1, Math.min(height - y, Math.round(rect.height)))
	};
}
