import type { ImageEditorCompletion } from '../common/imageEditorService.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWebviewService } from '../../../contrib/webview/browser/webview.js';
import { writeImageOutput } from './imageEditorOutput.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IHostService } from '../../host/browser/host.js';
import { type ImageEditorOptions } from '../common/imageEditorService.js';
import { ImageEditorService } from './imageEditorService.js';
import { createImageEditorWebview } from './imageEditorWebview.js';
import { readImageEditorTheme } from './imageEditorTheme.js';

export class BrowserImageEditorService extends ImageEditorService {
	private readonly interactionLifetime = this._register(new MutableDisposable());
	constructor(
		@IHostService private readonly host: IHostService,
		@IWebviewService private readonly webviews: IWebviewService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IFileService private readonly files: IFileService,
	) { super(); }

	public async capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined> {
		this.assertNotDisposed();
		const controller = new AbortController();
		const lifetime = toDisposable(() => controller.abort());
		this.interactionLifetime.value = lifetime;
		try {
			const resolved = await this.resolveInput(options, AbortSignal.any([signal, controller.signal]));
			return await new Promise<VSBuffer | undefined>((resolve, reject) => {
				let frame: IDisposable | undefined;
				let finished = false;
				const finish = (image?: Uint8Array, error?: unknown): void => {
					if (finished) return;
					finished = true;
					cancellation.dispose(); frame?.dispose();
					if (error) reject(error); else resolve(image ? VSBuffer.wrap(new Uint8Array(image)) : undefined);
				};
				const abort = () => finish();
				const cancellation = addDisposableListener(resolved.signal, 'abort', abort, { once: true });
				const open = async (): Promise<void> => {
					try {
						const image = options?.image?.buffer ?? (options?.code ? undefined : await this.getImage(resolved.signal));
						if (finished) return;
						if (!image && !options?.code) { finish(); return; }
						const input = {
							defaultAction: options?.defaultAction ?? 'attach',
							image, code: options?.code, state: resolved.view.state, theme: readImageEditorTheme(document),
							colorScheme: (document.querySelector('.ash-workbench') ?? document.body)?.getAttribute('data-color-scheme') ?? 'dark',
						};
						const complete = async (result: ImageEditorCompletion): Promise<boolean> => {
							if (result.kind === 'error') { finish(undefined, new Error(result.message)); return true; }
							if (result.kind === 'retake') {
								frame?.dispose(); frame = undefined;
								await new Promise<void>(paint => requestAnimationFrame(() => requestAnimationFrame(() => paint())));
								if (!finished) void open();
								return true;
							}
							if (result.kind === 'copy' || result.kind === 'save') {
								if (!await writeImageOutput(result.kind, result.image, this.clipboard, this.dialogs, this.files)) { return false; }
							}
							finish(result.kind === 'attach' ? result.image : undefined);
							return true;
						};
						frame = createImageEditorWebview(document, this.webviews, resolved.displayName, resolved.view.html, input, complete);
					} catch (error) { finish(undefined, error); }
				};
				if (resolved.signal.aborted) finish(); else void open();
			});
		} finally {
			if (this.interactionLifetime.value === lifetime) this.interactionLifetime.clear();
			lifetime.dispose();
		}
	}
	protected async getImage(_signal: AbortSignal): Promise<Uint8Array | undefined> { return (await this.host.getScreenshot())?.buffer; }
}
