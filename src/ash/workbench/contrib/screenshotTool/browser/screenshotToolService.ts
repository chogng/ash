import type { CodeImageOptions } from './codeImage.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { writeImageOutput } from '../../../services/imageEditor/browser/imageEditorOutput.js';
import type { ScreenshotToolInput } from './screenshotToolView.js';
import type { ScreenshotToolCompletion } from './screenshotTool.js';
import { readImageEditorTheme } from '../../../services/imageEditor/browser/imageEditorTheme.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IImageEditorService } from '../../../services/imageEditor/common/imageEditorService.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IScreenshotToolService, type IScreenshotToolOptions } from './screenshotTool.js';

export function getScreenshotAccessibilityHelp(agentWindow = false): string {
	const actions = agentWindow
		? localize('screenshot.agent.actionsHelp', 'Copy to Clipboard copies the final image and closes the editor. Enter does the same when the selection surface has focus. Download Screenshot asks where to save the image.')
		: localize('screenshot.capture.actionsHelp', 'Copy copies the final image. Save asks where to save it. When the selection surface has focus, Enter copies standalone screen and code images. Captures started from chat attach on Enter.');
	const annotations = agentWindow
		? localize('screenshot.agent.annotationHelp', 'Choose Shape, Arrow, Pen, Text, or Mosaic. Click the active tool again to return to selection. Shape offers Rectangle, Ellipse, Line, Outline, and Fill. Shape, Arrow, and Pen share line width and color. Text has its own font size and uses the current annotation color. Press Down Arrow on the active tool to focus its options.')
		: localize('screenshot.capture.annotationHelp', 'Choose Select before adjusting a region after annotation. Rectangle, Arrow, Pen, Text and Mosaic annotate the selection. Choose a color and line width before drawing.');
	return localize('screenshot.builtin.capture.help', "Screen capture\nDrag to select a region. Drag inside the selection to move it, or drag its eight handles to resize it. Arrow keys move the region; Shift+arrow keys resize it; Ctrl or Command increases the step to ten pixels. Entire screen selects the full image. Coordinates provides editable X, Y, Width and Height fields in image pixels. {1} Text opens an input at the clicked point; Enter commits it and Escape discards that text. Undo removes the last annotation. Retake captures the screen again. Frozen app images and code images offer Reset annotations, which removes all annotations and keeps the image and selection. On Desktop, Pin opens the annotated selection in an independent always-on-top window. Moving or resizing that window does not change the exported image. Closing a draft or starting another capture keeps pinned images open. {0} Add to Chat attaches the image to the originating draft when opened from chat, or the current chat when opened independently. Escape cancels the capture. Tab and Shift+Tab move between controls. Alt+F1 opens this help; Alt+F2 reads selection coordinates and annotation count. Image contents are not described.\nSelect code in an editor and run Screenshot: Create Code Image to render the selection without capturing the screen. Code image accessibility view includes the selected text.\nDesktop-wide capture is an Ash feature. If macOS requires Screen Recording permission, screenshot setup opens before capture. Use Allow in Settings and Check Again, or restart Ash if required. After allowing access, start a new screenshot. Code images and already captured images need no screen permission.", actions, annotations);
}

/** Owns screenshot presentation, configuration and request cancellation independently of extension providers. */
export class ScreenshotToolService extends Disposable implements IScreenshotToolService {
	private readonly interactionLifetime = this._register(new MutableDisposable());
	get isSupported(): boolean { return !this.isDisposed; }
	private get agentWindow(): boolean {
		const root = this.layout.mainContainer;
		return root.ownerDocument.defaultView!.getComputedStyle(root).getPropertyValue('--snapshot-presentation').trim() === 'neutral';
	}
	get accessibilityHelp(): string { return getScreenshotAccessibilityHelp(this.agentWindow); }
	constructor(
		@IImageEditorService private readonly images: IImageEditorService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IHostService private readonly host: IHostService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
		@ILayoutService private readonly layout: ILayoutService,
	) { super(); }

	async captureAndEdit(signal: AbortSignal, options: IScreenshotToolOptions = {}): Promise<VSBuffer | undefined> {
		return this.interact(signal, options, requestSignal => this.capture(options, requestSignal));
	}

	async show(options: IScreenshotToolOptions, signal: AbortSignal): Promise<void> {
		await this.interact(signal, options, async requestSignal => {
			const image = await this.capture({ ...options, defaultAction: 'copy' }, requestSignal);
			if (image && !requestSignal.aborted) { await this.images.attach(async draftSignal => requestSignal.aborted || draftSignal.aborted ? undefined : image); }
		});
	}

	protected get canPin(): boolean { return false; }
	protected async pin(_image: Uint8Array, _input: ScreenshotToolInput): Promise<void> { throw new Error('Pin is unavailable'); }

	/** Frozen images and code images stay in their requesting Workbench; native adapters override desktop acquisition. */
	protected async capture(options: IScreenshotToolOptions, signal: AbortSignal): Promise<VSBuffer | undefined> {
		signal.throwIfAborted();
		return new Promise<VSBuffer | undefined>((resolve, reject) => {
			const lifetime = new DisposableStore();
			let finished = false;
			let editor: import('./screenshotAnnotation.js').ScreenshotAnnotationEditor | undefined;
			const finish = (image?: Uint8Array, error?: unknown): void => {
				if (finished) { return; }
				finished = true;
				lifetime.dispose();
				if (error) { reject(error); } else { resolve(image ? VSBuffer.wrap(new Uint8Array(image)) : undefined); }
			};
			lifetime.add(addDisposableListener(signal, 'abort', () => finish(), { once: true }));
			const open = async (): Promise<void> => {
				try {
					const image = options.image?.buffer ?? (options.code ? undefined : (await this.host.getScreenshot())?.buffer);
					if (finished) { return; }
					if (!image && !options.code) { finish(); return; }
					const input = this.presentation(options, image);
					const { mountScreenshotTool } = await import('./screenshotToolView.js');
					const complete = async (result: ScreenshotToolCompletion): Promise<boolean> => {
						if (finished) { return true; }
						if (result.kind === 'retake') {
							editor?.dispose();
							await new Promise<void>(paint => requestAnimationFrame(() => requestAnimationFrame(() => paint())));
							if (!finished) { void open(); }
							return true;
						}
						if (result.kind === 'error') { finish(undefined, new Error(result.message)); return true; }
						if (result.kind === 'cancel') { finish(); return true; }
						if (result.kind === 'pin') { await this.pin(result.image, input); }
						if (result.kind === 'copy' || result.kind === 'save') {
							if (!await writeImageOutput(result.kind, result.image, this.clipboard, this.dialogs, this.files)) { return false; }
						}
						finish(result.kind === 'attach' ? result.image : undefined);
						return true;
					};
					editor = await mountScreenshotTool(document, input, complete, signal, input.agentWindow ? this.layout.mainContainer : undefined);
					lifetime.add(editor);
				} catch (error) { finish(undefined, error); }
			};
			void open();
		});
	}

	protected presentation(options: IScreenshotToolOptions, image?: Uint8Array): ScreenshotToolInput {
		const agentWindow = this.agentWindow;
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
			help: getScreenshotAccessibilityHelp(agentWindow),
		};
		return {
			image, code: options.code, canRetake: !options.image && !options.code, canPin: this.canPin,
			defaultAction: options.defaultAction ?? 'attach', state, agentWindow,
			theme: readImageEditorTheme(document, agentWindow ? this.layout.mainContainer : undefined),
			colorScheme: (document.querySelector('.ash-workbench') ?? document.body).getAttribute('data-color-scheme') ?? 'dark',
		};
	}

	protected async interact<T>(signal: AbortSignal, _options: IScreenshotToolOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
		if (this.isDisposed) {
			throw new Error(localize('screenshot.toolUnavailable', 'The screenshot tool is unavailable.'));
		}
		signal.throwIfAborted();
		const controller = new AbortController();
		const lifetime = toDisposable(() => controller.abort());
		// Own replacement before native preflight, so an older permission result cannot replace a newer capture.
		this.interactionLifetime.value = lifetime;
		try {
			return await run(AbortSignal.any([signal, controller.signal]));
		} finally {
			if (this.interactionLifetime.value === lifetime) this.interactionLifetime.clear();
			lifetime.dispose();
		}
	}
}
