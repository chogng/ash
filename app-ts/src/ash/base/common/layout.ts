export interface ISize {
	readonly width: number;
	readonly height: number;
}

export interface IRectangle extends ISize {
	readonly left: number;
	readonly top: number;
}

export enum AnchorAlignment {
	Left,
	Right,
}

export enum AnchorPosition {
	Below,
	Above,
}

export enum AnchorAxisAlignment {
	Vertical,
	Horizontal,
}

export interface Layout2DOptions {
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly gap?: number;
}

export interface Layout2DResult extends IRectangle {
	readonly right: number;
	readonly bottom: number;
	readonly anchorAlignment: AnchorAlignment;
	readonly anchorPosition: AnchorPosition;
}

/**
 * Places a rectangle next to an anchor, flipping the requested side or
 * alignment when that keeps more of the rectangle inside the viewport.
 *
 * The calculation is independent of DOM coordinate systems. Callers must
 * provide every rectangle in the same coordinate space.
 */
export function layout2d(
	viewport: IRectangle,
	view: ISize,
	anchor: IRectangle,
	options: Layout2DOptions = {},
): Layout2DResult {
	const axis = options.anchorAxisAlignment ??
		AnchorAxisAlignment.Vertical;
	const gap = Math.max(0, options.gap ?? 0);
	const requestedPosition = options.anchorPosition ??
		AnchorPosition.Below;
	const requestedAlignment = options.anchorAlignment ??
		AnchorAlignment.Left;

	const primary = axis === AnchorAxisAlignment.Vertical
		? placeBeside(
			viewport.top,
			viewport.height,
			view.height,
			anchor.top,
			anchor.height,
			requestedPosition,
			gap,
		)
		: placeBeside(
			viewport.left,
			viewport.width,
			view.width,
			anchor.left,
			anchor.width,
			requestedPosition,
			gap,
		);
	const cross = axis === AnchorAxisAlignment.Vertical
		? alignWithAnchor(
			viewport.left,
			viewport.width,
			view.width,
			anchor.left,
			anchor.width,
			requestedAlignment,
		)
		: alignWithAnchor(
			viewport.top,
			viewport.height,
			view.height,
			anchor.top,
			anchor.height,
			requestedAlignment,
		);

	const left = axis === AnchorAxisAlignment.Vertical
		? cross.offset
		: primary.offset;
	const top = axis === AnchorAxisAlignment.Vertical
		? primary.offset
		: cross.offset;

	return {
		left,
		top,
		width: view.width,
		height: view.height,
		right: left + view.width,
		bottom: top + view.height,
		anchorAlignment: cross.alignment,
		anchorPosition: primary.position,
	};
}

interface PrimaryPlacement {
	readonly offset: number;
	readonly position: AnchorPosition;
}

function placeBeside(
	viewportStart: number,
	viewportSize: number,
	viewSize: number,
	anchorStart: number,
	anchorSize: number,
	requested: AnchorPosition,
	gap: number,
): PrimaryPlacement {
	const viewportEnd = viewportStart + viewportSize;
	const anchorEnd = anchorStart + anchorSize;
	const after = anchorEnd + gap;
	const before = anchorStart - gap - viewSize;
	const fitsAfter = after + viewSize <= viewportEnd;
	const fitsBefore = before >= viewportStart;

	if (requested === AnchorPosition.Below) {
		if (fitsAfter) {
			return { offset: after, position: AnchorPosition.Below };
		}
		if (fitsBefore) {
			return { offset: before, position: AnchorPosition.Above };
		}
	} else {
		if (fitsBefore) {
			return { offset: before, position: AnchorPosition.Above };
		}
		if (fitsAfter) {
			return { offset: after, position: AnchorPosition.Below };
		}
	}

	const spaceAfter = Math.max(0, viewportEnd - after);
	const spaceBefore = Math.max(0, anchorStart - gap - viewportStart);
	const position = spaceAfter >= spaceBefore
		? AnchorPosition.Below
		: AnchorPosition.Above;
	const desired = position === AnchorPosition.Below ? after : before;
	return {
		offset: clampToViewport(
			desired,
			viewSize,
			viewportStart,
			viewportEnd,
		),
		position,
	};
}

interface CrossPlacement {
	readonly offset: number;
	readonly alignment: AnchorAlignment;
}

function alignWithAnchor(
	viewportStart: number,
	viewportSize: number,
	viewSize: number,
	anchorStart: number,
	anchorSize: number,
	requested: AnchorAlignment,
): CrossPlacement {
	const viewportEnd = viewportStart + viewportSize;
	const leftAligned = anchorStart;
	const rightAligned = anchorStart + anchorSize - viewSize;
	const leftFits = leftAligned + viewSize <= viewportEnd &&
		leftAligned >= viewportStart;
	const rightFits = rightAligned >= viewportStart &&
		rightAligned + viewSize <= viewportEnd;

	if (requested === AnchorAlignment.Left) {
		if (leftFits) {
			return {
				offset: leftAligned,
				alignment: AnchorAlignment.Left,
			};
		}
		if (rightFits) {
			return {
				offset: rightAligned,
				alignment: AnchorAlignment.Right,
			};
		}
	} else {
		if (rightFits) {
			return {
				offset: rightAligned,
				alignment: AnchorAlignment.Right,
			};
		}
		if (leftFits) {
			return {
				offset: leftAligned,
				alignment: AnchorAlignment.Left,
			};
		}
	}

	const desired = requested === AnchorAlignment.Left
		? leftAligned
		: rightAligned;
	return {
		offset: clampToViewport(
			desired,
			viewSize,
			viewportStart,
			viewportEnd,
		),
		alignment: requested,
	};
}

function clampToViewport(
	offset: number,
	size: number,
	viewportStart: number,
	viewportEnd: number,
): number {
	return Math.min(
		Math.max(offset, viewportStart),
		Math.max(viewportStart, viewportEnd - size),
	);
}
