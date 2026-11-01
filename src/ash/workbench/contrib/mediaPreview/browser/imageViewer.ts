import './media/imageViewer.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ImagePreviewConfiguration } from '../common/mediaPreview.js';
import { WebWorkerDescriptor } from '../../../../platform/webWorker/browser/webWorkerDescriptor.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import type { ImageEncoderWorker } from './imageEncoderWorker.js';

export type ImageViewerScale = number | 'fit';

export interface IImageViewerViewState {
	readonly scale: ImageViewerScale;
	readonly scrollLeft: number;
	readonly scrollTop: number;
}

export interface IImageViewerSourceOptions {
	readonly alt: string;
	readonly viewState?: IImageViewerViewState;
	readonly data: { readonly mimeType: string; read(): Promise<Uint8Array>; };
}

const zoomLevels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20];

/** Owns image geometry, scrolling and input; its host owns the source URL and placement. */
export class ImageViewer extends Disposable {
	/** Mounting surface. Hosts may place and size it, but must use semantic methods for content. */
	public readonly domNode: HTMLElement;
	private readonly imageDomNode: HTMLImageElement;
	private readonly pending = this._register(new MutableDisposable());
	private readonly scaleChanged = this._register(new Emitter<ImageViewerScale>());
	public readonly onDidChangeScale = this.scaleChanged.event;
	private currentScale: ImageViewerScale = 'fit';
	private size: { readonly width: number; readonly height: number; } | undefined;
	private sourceData: IImageViewerSourceOptions['data'] | undefined;
	private generation = 0;

	constructor(
		container: HTMLElement,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWebWorkerService private readonly workers: IWebWorkerService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div', { className: 'ash-image-viewer' });
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('aria-label', localize('media.image.viewport', 'Image viewport'));
		const stage = h(container.ownerDocument, 'div', { className: 'ash-image-viewer-stage' });
		this.imageDomNode = h(container.ownerDocument, 'img', { className: 'ash-image-viewer-image' });
		this.imageDomNode.draggable = false;
		stage.append(this.imageDomNode);
		this.domNode.append(stage);
		container.append(this.domNode);
		this._register(toDisposable(() => { this.clear(); this.domNode.remove(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ImagePreviewConfiguration.defaultZoom)) {
				this.setScale(this.defaultScale());
			} else if (event.affectsConfiguration(ImagePreviewConfiguration.fitToWindowPercentage) && this.scale === 'fit') {
				this.layout();
				this.scaleChanged.fire(this.scale);
			}
		}));
		this._register(addDisposableListener(this.domNode, 'wheel', event => {
			if (!event.ctrlKey && !(isMacintosh && event.altKey)) return;
			event.preventDefault();
			event.stopPropagation();
			if (!this.hasImage || event.deltaY === 0) return;
			if (event.ctrlKey) this.setScale(this.effectiveScale() * Math.exp(-event.deltaY / 100));
			else if (event.deltaY < 0) this.zoomIn();
			else this.zoomOut();
		}, { passive: false }));
		let clickCanZoom = false;
		this._register(addDisposableListener(this.domNode, 'mousedown', event => {
			clickCanZoom = event.button === 0 && this.hasFocus();
			this.domNode.focus({ preventScroll: true });
		}));
		this._register(addDisposableListener(this.domNode, 'click', event => {
			if (!clickCanZoom || event.button !== 0) return;
			if (isMacintosh ? event.altKey : event.ctrlKey) this.zoomOut();
			else this.zoomIn();
		}));
		this._register(addDisposableListener(this.domNode, 'copy', event => {
			if (!this.hasImage || !this.hasFocus()) return;
			event.preventDefault();
			this.runCopy();
		}));
		this._register(addDisposableListener(this.domNode, 'contextmenu', event => {
			if (!this.hasImage) return;
			event.preventDefault();
			this.menus.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY }), getActions: () => this.getActions() });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if ((isMacintosh ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'c') this.runCopy();
			else if (event.key === '+' || event.key === '=') this.zoomIn();
			else if (event.key === '-') this.zoomOut();
			else if (event.key === '0') this.setScale('fit');
			else if (event.key === '1') this.setScale(1);
			else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
				if (!this.hasImage) return;
				this.menus.showContextMenu({ getAnchor: () => this.domNode, getActions: () => this.getActions() });
			} else return;
			event.preventDefault();
			event.stopPropagation();
		}));
		const observer = new (getWindow(this.domNode).ResizeObserver)(() => this.layout());
		observer.observe(this.domNode);
		this._register(toDisposable(() => observer.disconnect()));
	}

	public get scale(): ImageViewerScale { return this.currentScale; }
	public get hasImage(): boolean { return this.size !== undefined; }
	public get naturalSize(): { readonly width: number; readonly height: number; } | undefined { return this.size; }
	public hasFocus(): boolean { return this.domNode.contains(this.domNode.ownerDocument.activeElement); }

	/** Decode separately so a slow or cancelled replacement cannot disturb the displayed image. */
	public async setSource(src: string, options: IImageViewerSourceOptions): Promise<boolean> {
		this.cancelPendingSource();
		const generation = this.generation;
		const probe = this.domNode.ownerDocument.createElement('img');
		probe.src = src;
		this.pending.value = toDisposable(() => probe.removeAttribute('src'));
		try {
			await probe.decode();
			if (this.isDisposed || generation !== this.generation) return false;
			this.size = { width: probe.naturalWidth, height: probe.naturalHeight };
			this.sourceData = options.data;
			this.imageDomNode.src = src;
			this.imageDomNode.alt = options.alt;
			this.currentScale = options.viewState?.scale ?? this.defaultScale();
			this.domNode.classList.add('ready');
			this.layout();
			this.domNode.scrollLeft = options.viewState?.scrollLeft ?? 0;
			this.domNode.scrollTop = options.viewState?.scrollTop ?? 0;
			this.scaleChanged.fire(this.scale);
			return true;
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return false;
			throw new TypeError(localize('media.image.invalid', 'The image data could not be decoded.'), { cause: error });
		} finally {
			if (generation === this.generation) this.pending.clear();
		}
	}

	public cancelPendingSource(): void { this.generation++; this.pending.clear(); }

	public clear(): void {
		this.cancelPendingSource();
		this.size = undefined;
		this.sourceData = undefined;
		this.currentScale = 'fit';
		this.domNode.classList.remove('ready');
		this.imageDomNode.removeAttribute('src');
		this.imageDomNode.alt = '';
	}

	public getViewState(): IImageViewerViewState {
		return { scale: this.scale, scrollLeft: this.domNode.scrollLeft, scrollTop: this.domNode.scrollTop };
	}

	public restoreViewState(state: IImageViewerViewState): void {
		this.setScale(state.scale);
		this.domNode.scrollLeft = state.scrollLeft;
		this.domNode.scrollTop = state.scrollTop;
	}

	public setScale(scale: ImageViewerScale): void {
		if (!this.size) return;
		const previous = this.effectiveScale();
		const centerX = (this.domNode.scrollLeft + this.domNode.clientWidth / 2) / previous;
		const centerY = (this.domNode.scrollTop + this.domNode.clientHeight / 2) / previous;
		this.currentScale = scale === 'fit' ? scale : Math.min(20, Math.max(0.1, scale));
		this.layout();
		const next = this.effectiveScale();
		this.domNode.scrollLeft = Math.max(0, centerX * next - this.domNode.clientWidth / 2);
		this.domNode.scrollTop = Math.max(0, centerY * next - this.domNode.clientHeight / 2);
		this.scaleChanged.fire(this.scale);
	}

	public zoomIn(): void {
		const scale = this.effectiveScale();
		// A tiny fitted image can already exceed the manual zoom limit.
		if (scale >= 20) return;
		this.setScale(zoomLevels.find(level => level > scale + 0.0001) ?? 20);
	}
	public zoomOut(): void { this.setScale([...zoomLevels].reverse().find(level => level < this.effectiveScale() - 0.0001) ?? 0.1); }

	public layout(): void {
		if (!this.size) return;
		const scale = this.effectiveScale();
		this.imageDomNode.style.width = `${this.size.width * scale}px`;
		this.imageDomNode.style.height = `${this.size.height * scale}px`;
		this.imageDomNode.classList.toggle('pixelated', scale >= 3 && this.sourceData?.mimeType !== 'image/svg+xml');
	}

	private getActions(): IAction[] {
		const action = (id: string, label: string, run: () => void): IAction => ({ id, label, tooltip: label, enabled: this.hasImage, run });
		return [
			action('imagePreview.fit', localize('media.image.fit', 'Fit to window'), () => this.setScale('fit')),
			action('imagePreview.actualSize', localize('media.image.actualSize', 'Actual size'), () => this.setScale(1)),
			action('imagePreview.zoomOut', localize('media.image.zoomOut', 'Zoom out'), () => this.zoomOut()),
			action('imagePreview.zoomIn', localize('media.image.zoomIn', 'Zoom in'), () => this.zoomIn()),
			action('imagePreview.copy', localize('media.image.copy', 'Copy image'), () => this.runCopy()),
		];
	}

	public async copyImage(): Promise<void> {
		if (!this.sourceData || !this.size) return;
		// Capture the source synchronously: switching tabs during encoding must copy the requested image.
		const data = this.sourceData;
		const image = this.imageDomNode.cloneNode() as HTMLImageElement;
		const encode = async (): Promise<Uint8Array> => {
			if (data.mimeType === 'image/png') return data.read();
			return encodeImageAsPng(image, this.workers);
		};
		await this.clipboard.writeImage(encode());
	}

	private readonly copyFailed = this._register(new Emitter<unknown>());
	public readonly onDidFailCopy = this.copyFailed.event;
	private runCopy(): void { void this.copyImage().catch(error => this.copyFailed.fire(error)); }

	private effectiveScale(): number {
		if (this.currentScale !== 'fit' || !this.size) return this.currentScale === 'fit' ? 1 : this.currentScale;
		const fraction = this.configuration.getValue<number>(ImagePreviewConfiguration.fitToWindowPercentage) / 100;
		return Math.min(fraction * this.domNode.clientWidth / this.size.width, fraction * this.domNode.clientHeight / this.size.height) || 1;
	}

	private defaultScale(): ImageViewerScale {
		return this.configuration.getValue<'fit' | 'actualSize'>(ImagePreviewConfiguration.defaultZoom) === 'actualSize' ? 1 : 'fit';
	}
}

/** Keep each copy independent of tab changes, and terminate its Worker when encoding settles. */
async function encodeImageAsPng(image: HTMLImageElement, workers: IWebWorkerService): Promise<Uint8Array> {
	try {
		await image.decode();
		const bitmap = await getWindow(image).createImageBitmap(image);
		try {
			using worker = workers.createWorkerClient<ImageEncoderWorker>(new WebWorkerDescriptor({
				label: 'ash-image-encoder',
				createWorker: () => new Worker(new URL('./imageEncoderWorkerMain.ts', import.meta.url), { type: 'module', name: 'ash-image-encoder' }),
			}));
			return new Uint8Array(await worker.proxy.$encodePng(bitmap));
		} finally {
			bitmap.close();
		}
	} catch (error) {
		throw new Error(localize('media.image.encodingFailed', 'Could not encode the image as PNG: {0}', error instanceof Error ? error.message : String(error)), { cause: error });
	}
}
