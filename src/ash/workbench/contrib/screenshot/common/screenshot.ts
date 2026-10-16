import type { Event } from '../../../../base/common/event.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';

export const ScreenshotGlobalShortcutSetting = 'screenshot.globalShortcut';
export const ScreenshotCommandId = 'workbench.action.chat.attachScreenshot';

export interface ScreenshotShortcutStatus {
	readonly availability: 'unchecked' | 'available' | 'unavailable' | 'unsupported' | 'unassigned' | 'unknown';
	readonly global: boolean;
	readonly activeLabel: string;
}

/** Workbench-owned manual capture. Only Add to Chat returns image bytes; other completions return undefined. */
export interface IScreenshotService {
	readonly onDidChangeShortcut: Event<void>;
	readonly shortcutStatus: ScreenshotShortcutStatus;
	checkShortcut(): Promise<void>;
	captureScreenshot(signal: AbortSignal): Promise<VSBuffer | undefined>;
}

export const IScreenshotService = createServiceIdentifier<IScreenshotService>('screenshotService');

export function getScreenshotAccessibilityHelp(): string {
	return localize(
		'screenshot.help',
		'Screen capture\nDrag to select a region. Drag inside the selection to move it, or drag its eight handles to resize it. Choose Select before adjusting a region after annotation. Arrow keys move the region; Shift+arrow keys resize it; Ctrl or Command increases the step to ten pixels. Entire screen selects the full image. Coordinates provides editable X, Y, Width and Height fields in image pixels. Rectangle, Arrow, Pen, Text and Mosaic annotate the selection. Choose a color and line width before drawing. Text opens an input at the clicked point; Enter commits it and Escape discards that text. Undo removes the last annotation. Copy copies the final image, Save asks where to save it, and Add to Chat attaches it to the originating draft. Enter confirms when the selection surface has focus. Escape cancels the capture. Tab and Shift+Tab move between controls. Alt+F1 opens this help; Alt+F2 reads selection coordinates and annotation count. Image contents are not described.'
	);
}
