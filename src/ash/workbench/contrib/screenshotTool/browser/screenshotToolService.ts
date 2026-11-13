import type { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage, getNlsMessages, localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IImageEditorService } from '../../../services/imageEditor/common/imageEditorService.js';
import { IScreenshotToolService, type IScreenshotToolOptions } from './screenshotTool.js';

function getScreenshotAccessibilityHelp(): string {
	return localize('screenshot.builtin.capture.help', "Screen capture\nDrag to select a region. Drag inside the selection to move it, or drag its eight handles to resize it. Choose Select before adjusting a region after annotation. Arrow keys move the region; Shift+arrow keys resize it; Ctrl or Command increases the step to ten pixels. Entire screen selects the full image. Coordinates provides editable X, Y, Width and Height fields in image pixels. Rectangle, Arrow, Pen, Text and Mosaic annotate the selection. Choose a color and line width before drawing. Text opens an input at the clicked point; Enter commits it and Escape discards that text. Undo removes the last annotation. Copy copies the final image, Save asks where to save it, and Add to Chat attaches it to the originating draft when opened from chat, or the current chat when opened independently. When the selection surface has focus, Enter copies standalone screen and code images; captures started from chat attach on Enter. Escape cancels the capture. Tab and Shift+Tab move between controls. Alt+F1 opens this help; Alt+F2 reads selection coordinates and annotation count. Image contents are not described.\nSelect code in an editor and run Screenshot: Create Code Image to render the selection without capturing the screen. Code image accessibility view includes the selected text.\nDesktop-wide capture is an Ash feature. If macOS requires Screen Recording permission, screenshot setup opens before capture. Use Allow in Settings and Check Again, or restart Ash if required. After allowing access, start a new screenshot. Code images and already captured images need no screen permission.");
}

/** Builds a self-contained view; host windows and Browser frames use the same editor assets. */
export async function createScreenshotToolView(state: { readonly accessibilityHints?: boolean; readonly code?: unknown; } = {}) {
	const { default: assets } = await import('virtual:ash-screenshot-tool-view');
	const messages = Object.fromEntries(Object.entries(getNlsMessages().ash ?? {}).filter(([key]) =>
		key.startsWith('screenshot.') || key.startsWith('chat.screenshot.') || key.startsWith('snapshot.code.')));
	return {
		html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src data:"><style>${assets.style.replace(/<\/style/gi, '<\\/style')}</style><script>${assets.script.replace(/<\/script/gi, '<\\/script')}</script>`,
		state: {
			...state,
			locale: getNLSLanguage(),
			bundles: { ash: messages },
			help: getScreenshotAccessibilityHelp(),
		},
	};
}

/** Owns screenshot presentation, configuration and request cancellation independently of extension providers. */
export class ScreenshotToolService extends Disposable implements IScreenshotToolService {
	private readonly lifetime = new AbortController();
	get isSupported(): boolean { return !this.isDisposed; }
	get accessibilityHelp(): string { return getScreenshotAccessibilityHelp(); }
	constructor(
		@IImageEditorService private readonly images: IImageEditorService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { super(); }

	async captureAndEdit(signal: AbortSignal, options: IScreenshotToolOptions = {}): Promise<VSBuffer | undefined> {
		return this.interact(signal, async requestSignal => {
			const presentation = await this.presentation(requestSignal);
			return this.images.capture(requestSignal, { ...options, presentation });
		});
	}

	async show(options: IScreenshotToolOptions, signal: AbortSignal): Promise<void> {
		await this.interact(signal, async requestSignal => {
			const presentation = await this.presentation(requestSignal);
			return this.images.show({ ...options, presentation }, requestSignal);
		});
	}

	private async presentation(signal: AbortSignal) {
		const code = Object.fromEntries([
			'padding', 'scale', 'background', 'lineNumbers', 'realLineNumbers',
			'windowControls', 'windowTitle', 'transparent',
		].map(key => [key, this.configuration.getValue(`snapshot.code.${key}`)]));
		const view = await createScreenshotToolView({
			accessibilityHints: this.configuration.getValue<boolean>('accessibility.verbosity.chatScreenshot') !== false,
			code,
		});
		signal.throwIfAborted();
		return { ...view, displayName: localize('screenshot.builtin.title', 'Screenshot') };
	}

	protected async interact<T>(signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.isDisposed) {
			throw new Error(localize('screenshot.toolUnavailable', 'The screenshot tool is unavailable.'));
		}
		const requestSignal = AbortSignal.any([signal, this.lifetime.signal]);
		requestSignal.throwIfAborted();
		return run(requestSignal);
	}

	protected override disposeCore(): void {
		this.lifetime.abort();
		super.disposeCore();
	}
}
