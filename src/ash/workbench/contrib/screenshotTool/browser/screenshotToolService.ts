import type { CodeImageOptions } from './codeImage.js';
import type { ImageViewCompletion } from '../../../../platform/imageView/common/imageView.js';
import { readImageEditorTheme } from '../../../services/imageEditor/browser/imageEditorTheme.js';
import type { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IImageEditorService } from '../../../services/imageEditor/common/imageEditorService.js';
import { IScreenshotToolService, type IScreenshotToolOptions } from './screenshotTool.js';

export function getScreenshotAccessibilityHelp(): string {
	return localize('screenshot.builtin.capture.help', "Screen capture\nDrag to select a region. Drag inside the selection to move it, or drag its eight handles to resize it. Choose Select before adjusting a region after annotation. Arrow keys move the region; Shift+arrow keys resize it; Ctrl or Command increases the step to ten pixels. Entire screen selects the full image. Coordinates provides editable X, Y, Width and Height fields in image pixels. Rectangle, Arrow, Pen, Text and Mosaic annotate the selection. Choose a color and line width before drawing. Text opens an input at the clicked point; Enter commits it and Escape discards that text. Undo removes the last annotation. Copy copies the final image, Save asks where to save it, and Add to Chat attaches it to the originating draft when opened from chat, or the current chat when opened independently. When the selection surface has focus, Enter copies standalone screen and code images; captures started from chat attach on Enter. Escape cancels the capture. Tab and Shift+Tab move between controls. Alt+F1 opens this help; Alt+F2 reads selection coordinates and annotation count. Image contents are not described.\nSelect code in an editor and run Screenshot: Create Code Image to render the selection without capturing the screen. Code image accessibility view includes the selected text.\nDesktop-wide capture is an Ash feature. If macOS requires Screen Recording permission, screenshot setup opens before capture. Use Allow in Settings and Check Again, or restart Ash if required. After allowing access, start a new screenshot. Code images and already captured images need no screen permission.");
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
			const presentation = await this.presentation(requestSignal, options);
			return this.images.capture(requestSignal, { ...options, presentation });
		});
	}

	async show(options: IScreenshotToolOptions, signal: AbortSignal): Promise<void> {
		options = { ...options, defaultAction: 'copy' };
		await this.interact(signal, async requestSignal => {
			const presentation = await this.presentation(requestSignal, options);
			return this.images.show({ ...options, presentation }, requestSignal);
		});
	}

	private async presentation(signal: AbortSignal, options: IScreenshotToolOptions) {
		const code: CodeImageOptions = {
			padding: this.configuration.getValue('snapshot.code.padding'),
			scale: this.configuration.getValue('snapshot.code.scale'),
			background: this.configuration.getValue('snapshot.code.background'),
			lineNumbers: this.configuration.getValue('snapshot.code.lineNumbers'),
			realLineNumbers: this.configuration.getValue('snapshot.code.realLineNumbers'),
			windowControls: this.configuration.getValue('snapshot.code.windowControls'),
			windowTitle: this.configuration.getValue('snapshot.code.windowTitle'),
			transparent: this.configuration.getValue('snapshot.code.transparent'),
		};
		const state = {
			accessibilityHints: this.configuration.getValue<boolean>('accessibility.verbosity.chatScreenshot') !== false,
			code,
			help: this.accessibilityHelp,
		};
		signal.throwIfAborted();
		return {
			html: '',
			renderer: 'builtin' as const,
			state,
			mount: async (image: Uint8Array | undefined, complete: (result: ImageViewCompletion) => Promise<boolean>, requestSignal: AbortSignal) => {
				const { mountScreenshotTool } = await import('./screenshotToolView.js');
				return mountScreenshotTool(document, {
					image, code: options.code,
					defaultAction: options.defaultAction ?? 'attach',
					state, theme: readImageEditorTheme(document),
					colorScheme: (document.querySelector('.ash-workbench') ?? document.body).getAttribute('data-color-scheme') ?? 'dark',
				}, complete, requestSignal);
			},
			displayName: localize('screenshot.builtin.title', 'Screenshot')
		};
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
