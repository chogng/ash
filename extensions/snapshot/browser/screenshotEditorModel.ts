import type { ImageRectangle as IRectangle } from '../common/image.js';

export interface ScreenshotPoint {
	readonly x: number;
	readonly y: number;
}
export type ScreenshotTool = 'select' | 'rectangle' | 'arrow' | 'pen' | 'text' | 'mosaic';
export interface ScreenshotAnnotation {
	readonly tool: Exclude<ScreenshotTool, 'select'>;
	readonly points: readonly ScreenshotPoint[];
	readonly color: string;
	readonly width: number;
	readonly text?: string;
}

/** Edge rounding keeps reverse drags and mixed display scales on one image-pixel grid. */
export function screenshotRectangle(start: ScreenshotPoint, end: ScreenshotPoint): IRectangle {
	const x = Math.round(Math.min(start.x, end.x));
	const y = Math.round(Math.min(start.y, end.y));
	return {
		x,
		y,
		width: Math.max(1, Math.round(Math.max(start.x, end.x)) - x),
		height: Math.max(1, Math.round(Math.max(start.y, end.y)) - y),
	};
}

export function clampScreenshotRectangle(rect: IRectangle, width: number, height: number): IRectangle {
	const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
	const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
	return {
		x,
		y,
		width: Math.max(1, Math.min(width - x, Math.round(rect.width))),
		height: Math.max(1, Math.min(height - y, Math.round(rect.height))),
	};
}

/** Draw in source pixels so preview and export use the same annotation operations. */
export function paintScreenshotAnnotation(context: CanvasRenderingContext2D, annotation: ScreenshotAnnotation): void {
	const [start] = annotation.points;
	const end = annotation.points.at(-1)!;
	context.save();
	context.strokeStyle = annotation.color;
	context.fillStyle = annotation.color;
	context.lineWidth = annotation.width;
	context.lineCap = 'round';
	context.lineJoin = 'round';
	if (annotation.tool === 'mosaic') {
		const rect = screenshotRectangle(start, end);
		// Pixelate the current image, including earlier marks, without exposing the original under the patch.
		const patch = context.canvas.ownerDocument.createElement('canvas');
		patch.width = Math.max(1, Math.ceil(rect.width / 14));
		patch.height = Math.max(1, Math.ceil(rect.height / 14));
		patch
			.getContext('2d')!
			.drawImage(context.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, patch.width, patch.height);
		context.imageSmoothingEnabled = false;
		context.drawImage(patch, 0, 0, patch.width, patch.height, rect.x, rect.y, rect.width, rect.height);
	} else if (annotation.tool === 'rectangle') {
		context.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
	} else if (annotation.tool === 'text') {
		context.font = `${Math.max(18, annotation.width * 6)}px sans-serif`;
		context.textBaseline = 'top';
		context.fillText(annotation.text ?? '', start.x, start.y);
	} else {
		context.beginPath();
		context.moveTo(start.x, start.y);
		for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y);
		context.stroke();
		if (annotation.tool === 'arrow') {
			const angle = Math.atan2(end.y - start.y, end.x - start.x);
			const length = Math.max(12, annotation.width * 4);
			context.beginPath();
			context.moveTo(
				end.x - length * Math.cos(angle - Math.PI / 6),
				end.y - length * Math.sin(angle - Math.PI / 6),
			);
			context.lineTo(end.x, end.y);
			context.lineTo(
				end.x - length * Math.cos(angle + Math.PI / 6),
				end.y - length * Math.sin(angle + Math.PI / 6),
			);
			context.stroke();
		}
	}
	context.restore();
}
