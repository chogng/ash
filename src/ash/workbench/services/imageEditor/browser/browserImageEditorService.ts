import { addDisposableListener } from '../../../../base/browser/dom.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IHostService } from '../../host/browser/host.js';
import { IImageEditorService, type ImageEditorOptions } from '../common/imageEditorService.js';
import { ImageEditorService } from './imageEditorService.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createImageViewFrame } from '../../../../platform/imageView/browser/imageViewFrame.js';
import { readImageEditorTheme } from './imageEditorTheme.js';

export class BrowserImageEditorService extends ImageEditorService {
	private readonly interactionLifetime = this._register(new MutableDisposable());
	constructor(
		@IHostService private readonly host: IHostService,
	) { super(); }

	public async capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined> {
		this.assertNotDisposed();
		const controller = new AbortController();
		const lifetime = toDisposable(() => controller.abort());
		this.interactionLifetime.value = lifetime;
		try {
			const resolved = await this.resolve(options?.code ? 'selection' : 'screen', AbortSignal.any([signal, controller.signal]), options?.editorId);
			return await new Promise<VSBuffer | undefined>((resolve, reject) => {
				let frame: ReturnType<typeof createImageViewFrame> | undefined;
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
						const image = options?.code ? undefined : (await this.host.getScreenshot())?.buffer;
						if (finished) return;
						if (!image && !options?.code) { finish(); return; }
						frame = createImageViewFrame(document, resolved.displayName, resolved.view.html, {
							image, code: options?.code, state: resolved.view.state, theme: readImageEditorTheme(document),
							colorScheme: (document.querySelector('.ash-workbench') ?? document.body)?.getAttribute('data-color-scheme') ?? 'dark',
						}, async result => {
							if (result.kind === 'error') { finish(undefined, new Error(result.message)); return true; }
							if (result.kind === 'retake') {
								frame?.dispose(); frame = undefined;
								await new Promise<void>(paint => requestAnimationFrame(() => requestAnimationFrame(() => paint())));
								if (!finished) void open();
								return true;
							}
							if (result.kind === 'copy') await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(result.image)], { type: 'image/png' }) })]);
							if (result.kind === 'save') {
								const url = URL.createObjectURL(new Blob([new Uint8Array(result.image)], { type: 'image/png' }));
								const link = document.createElement('a'); link.href = url; link.download = 'Image.png'; link.click();
								setTimeout(() => URL.revokeObjectURL(url), 1000);
							}
							finish(result.kind === 'attach' ? result.image : undefined);
							return true;
						}, () => { });
					} catch (error) { finish(undefined, error); }
				};
				if (resolved.signal.aborted) finish(); else void open();
			});
		} finally {
			if (this.interactionLifetime.value === lifetime) this.interactionLifetime.clear();
			lifetime.dispose();
		}
	}
}

registerSingleton(IImageEditorService, BrowserImageEditorService, InstantiationType.Delayed);
