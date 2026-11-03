export interface IWindowControlsOverlayTitlebarRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface IWindowControlsOverlayViewport {
	readonly top: number;
	readonly left: number;
	readonly width: number;
	readonly height: number;
}

export interface IWindowControlsOverlaySize {
	readonly width: number;
	readonly height: number;
}

export interface IWindowControlsOverlayPosition {
	readonly top: number;
	readonly left: number;
}

/**
 * Keeps a floating view out of the control strips on either side of the titlebar.
 * The titlebar rectangle is relative to the viewport origin; positions include that origin.
 */
export function avoidWindowControlsOverlay(
	titlebarAreaRect: IWindowControlsOverlayTitlebarRect | undefined,
	viewport: IWindowControlsOverlayViewport,
	view: IWindowControlsOverlaySize,
	position: IWindowControlsOverlayPosition,
): IWindowControlsOverlayPosition {
	if (!titlebarAreaRect) {
		return position;
	}
	const titlebarRight = titlebarAreaRect.x + titlebarAreaRect.width;
	const titlebarBottom = titlebarAreaRect.y + titlebarAreaRect.height;
	// The optional browser API can report empty or unusable geometry during mode changes.
	if (titlebarAreaRect.width <= 0 || titlebarAreaRect.height <= 0 ||
		!Number.isFinite(titlebarRight) || !Number.isFinite(titlebarBottom)) {
		return position;
	}
	const right = viewport.left + viewport.width;
	const bottom = viewport.top + viewport.height;
	const bandTop = Math.max(viewport.top, viewport.top + titlebarAreaRect.y);
	const bandBottom = Math.min(bottom, viewport.top + titlebarBottom);
	const safeLeft = Math.max(viewport.left, viewport.left + titlebarAreaRect.x);
	const safeRight = Math.min(right, viewport.left + titlebarRight);
	if (bandBottom <= bandTop || position.top >= bandBottom || position.top + view.height <= bandTop ||
		(position.left >= safeLeft && position.left + view.width <= safeRight)) {
		return position;
	}

	// Keep the anchor's horizontal placement when there is room below the native controls.
	if (bandBottom + view.height <= bottom) {
		return { left: position.left, top: bandBottom };
	}
	if (view.width <= safeRight - safeLeft) {
		return {
			left: Math.min(Math.max(position.left, safeLeft), safeRight - view.width),
			top: position.top,
		};
	}
	// Some views cannot clear both strips. Preserve access to their content within the viewport.
	return { left: position.left, top: Math.max(viewport.top, bottom - view.height) };
}
