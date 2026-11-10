import './media/imageViewer.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import type { IAction } from '../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { clamp } from '../../../../base/common/numbers.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ImagePreviewConfiguration } from '../common/mediaPreview.js';
import { IWebWorkerService } from '../../../../platform/webWorker/browser/webWorkerService.js';
import { encodeImageAsPng } from './imageEncoder.js';

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

interface PinchAxis {
	readonly viewport: number;
	readonly scroll: number;
	readonly start: number;
	readonly center: number;
}

function capturePinchAxis(viewport: number, scroll: number, imageSize: number, scale: number): PinchAxis {
	const start = Math.max(0, (viewport - imageSize * scale) / 2) - scroll;
	return { viewport, scroll, start, center: (viewport / 2 - start) / scale };
}

/** Image origin relative to the viewport, respecting centering and scroll limits. */
function pinchImageStart(axis: PinchAxis, scaledSize: number, scale: number): number {
	return scaledSize <= axis.viewport
		? (axis.viewport - scaledSize) / 2
		: -clamp(axis.center * scale - axis.viewport / 2, 0, scaledSize - axis.viewport);
}

/** Owns image geometry, scrolling and input; its host owns the source URL and placement. */
export class ImageViewer extends Disposable {
	/** Mounting surface. Hosts may place and size it, but must use semantic methods for content. */
	public readonly domNode: HTMLElement;
	private readonly imageDomNode: HTMLImageElement;
	private readonly media: HTMLElement;
	private readonly pending = this._register(new MutableDisposable());
	private readonly pinchZoomFrame: AnimationFrameScheduler;
	private readonly pinchZoomIdle = this._register(new RunOnceScheduler(() => this.finishPinchZoom(), 120));
	private pinchZoom: { readonly baseScale: number; readonly x: PinchAxis; readonly y: PinchAxis; scale: number; } | undefined;
	private readonly scaleChanged = this._register(new Emitter<ImageViewerScale>());
	public readonly onDidChangeScale = this.scaleChanged.event;
	private readonly displayScaleChanged = this._register(new Emitter<number>());
	public readonly onDidChangeDisplayScale = this.displayScaleChanged.event;
	private currentScale: ImageViewerScale = 'fit';
	private size: { readonly width: number; readonly height: number; } | undefined;
	private sourceData: IImageViewerSourceOptions['data'] | undefined;
	private generation = 0;

	constructor(
		container: HTMLElement,
		options: { readonly contextMenu?: boolean; readonly overlay?: SVGSVGElement; },
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
		this.media = h(container.ownerDocument, 'div', { className: 'ash-image-viewer-media' });
		this.media.append(this.imageDomNode);
		if (options.overlay) this.media.append(options.overlay);
		stage.append(this.media);
		this.domNode.append(stage);
		container.append(this.domNode);
		this.pinchZoomFrame = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => this.renderPinchZoom()));
		this._register(toDisposable(() => { this.clear(); this.domNode.remove(); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ImagePreviewConfiguration.defaultZoom)) {
				this.setScale(this.defaultScale());
			} else if (event.affectsConfiguration(ImagePreviewConfiguration.fitToWindowPercentage) && this.scale === 'fit') {
				this.layout();
				if (this.scale === 'fit') this.scaleChanged.fire(this.scale);
			}
		}));
		this._register(addDisposableListener(this.domNode, 'wheel', event => {
			if (!event.ctrlKey && !(isMacintosh && event.altKey)) {
				this.finishPinchZoom();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (!this.hasImage || event.deltaY === 0) return;
			if (event.ctrlKey) this.queuePinchZoom(event.deltaY);
			else if (event.deltaY < 0) this.zoomIn();
			else this.zoomOut();
		}, { passive: false }));
		this._register(addDisposableListener(this.domNode, 'scroll', () => {
			const pinch = this.pinchZoom;
			if (pinch && (pinch.x.scroll !== this.domNode.scrollLeft || pinch.y.scroll !== this.domNode.scrollTop)) this.finishPinchZoom();
		}));
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
			if (options.contextMenu === false) return;
			this.menus.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY }), getActions: () => this.getActions() });
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if ((isMacintosh ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === 'c') this.runCopy();
			else if (event.key === '+' || event.key === '=') this.zoomIn();
			else if (event.key === '-') this.zoomOut();
			else if (event.key === '0') this.setScale('fit');
			else if (event.key === '1') this.setScale(1);
			else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
				if (!this.hasImage || options.contextMenu === false) return;
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
			this.cancelPinchZoom();
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
		this.cancelPinchZoom();
		this.size = undefined;
		this.sourceData = undefined;
		this.currentScale = 'fit';
		this.domNode.classList.remove('ready');
		this.imageDomNode.removeAttribute('src');
		this.imageDomNode.alt = '';
	}

	public getViewState(): IImageViewerViewState {
		const pinch = this.pinchZoom;
		if (pinch && this.size) {
			return {
				scale: pinch.scale,
				scrollLeft: Math.max(0, -pinchImageStart(pinch.x, this.size.width * pinch.scale, pinch.scale)),
				scrollTop: Math.max(0, -pinchImageStart(pinch.y, this.size.height * pinch.scale, pinch.scale)),
			};
		}
		return { scale: this.scale, scrollLeft: this.domNode.scrollLeft, scrollTop: this.domNode.scrollTop };
	}

	public restoreViewState(state: IImageViewerViewState): void {
		this.setScale(state.scale);
		this.domNode.scrollLeft = state.scrollLeft;
		this.domNode.scrollTop = state.scrollTop;
	}

	public setScale(scale: ImageViewerScale): void {
		const pinch = this.pinchZoom;
		this.cancelPinchZoom();
		if (!this.size) return;
		const previous = this.effectiveScale();
		const centerX = pinch
			? pinch.x.center + (this.domNode.scrollLeft - pinch.x.scroll) / pinch.scale
			: (this.domNode.scrollLeft + this.domNode.clientWidth / 2) / previous;
		const centerY = pinch
			? pinch.y.center + (this.domNode.scrollTop - pinch.y.scroll) / pinch.scale
			: (this.domNode.scrollTop + this.domNode.clientHeight / 2) / previous;
		this.currentScale = scale === 'fit' ? scale : clamp(scale, 0.1, 20);
		this.layout();
		const next = this.effectiveScale();
		this.domNode.scrollLeft = Math.max(0, centerX * next - this.domNode.clientWidth / 2);
		this.domNode.scrollTop = Math.max(0, centerY * next - this.domNode.clientHeight / 2);
		this.scaleChanged.fire(this.scale);
	}

	public zoomIn(): void {
		const scale = this.pinchZoom?.scale ?? this.effectiveScale();
		// A tiny fitted image can already exceed the manual zoom limit.
		if (scale >= 20) return;
		this.setScale(zoomLevels.find(level => level > scale + 0.0001) ?? 20);
	}
	public zoomOut(): void {
		const scale = this.pinchZoom?.scale ?? this.effectiveScale();
		this.setScale([...zoomLevels].reverse().find(level => level < scale - 0.0001) ?? 0.1);
	}

	public layout(): void {
		if (!this.size) return;
		if (this.pinchZoom) {
			this.finishPinchZoom();
			return;
		}
		const scale = this.effectiveScale();
		this.imageDomNode.style.width = `${this.size.width * scale}px`;
		this.imageDomNode.style.height = `${this.size.height * scale}px`;
		this.imageDomNode.classList.toggle('pixelated', scale >= 3 && this.sourceData?.mimeType !== 'image/svg+xml');
		this.displayScaleChanged.fire(scale);
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

	private queuePinchZoom(deltaY: number): void {
		const size = this.size;
		if (!size) return;
		let pinch = this.pinchZoom;
		const previous = pinch?.scale ?? this.effectiveScale();
		const scale = clamp(previous * Math.exp(-deltaY / 100), 0.1, 20);
		// Wheel-based pinches have no end event. Hold the native scroll geometry fixed
		// until input settles, then commit the scale and scroll together.
		if (!pinch) {
			if (scale === this.scale) return;
			pinch = this.pinchZoom = {
				baseScale: previous,
				x: capturePinchAxis(this.domNode.clientWidth, this.domNode.scrollLeft, size.width, previous),
				y: capturePinchAxis(this.domNode.clientHeight, this.domNode.scrollTop, size.height, previous),
				scale: previous,
			};
			this.media.style.willChange = 'transform';
		}
		if (scale !== pinch.scale) {
			pinch.scale = scale;
			this.pinchZoomFrame.schedule();
		}
		this.pinchZoomIdle.schedule();
	}

	private renderPinchZoom(): void {
		const pinch = this.pinchZoom;
		const size = this.size;
		if (!pinch || !size) return;
		const x = pinchImageStart(pinch.x, size.width * pinch.scale, pinch.scale) - pinch.x.start;
		const y = pinchImageStart(pinch.y, size.height * pinch.scale, pinch.scale) - pinch.y.start;
		this.media.style.transform = `translate(${x}px, ${y}px) scale(${pinch.scale / pinch.baseScale})`;
		this.displayScaleChanged.fire(pinch.scale);
	}

	private finishPinchZoom(): void {
		if (this.pinchZoom) this.setScale(this.pinchZoom.scale);
	}

	private cancelPinchZoom(): void {
		this.pinchZoomFrame.cancel();
		this.pinchZoomIdle.cancel();
		if (this.pinchZoom) {
			this.pinchZoom = undefined;
			this.media.style.transform = '';
			this.media.style.willChange = '';
		}
	}

	private effectiveScale(): number {
		if (this.currentScale !== 'fit' || !this.size) return this.currentScale === 'fit' ? 1 : this.currentScale;
		const fraction = this.configuration.getValue<number>(ImagePreviewConfiguration.fitToWindowPercentage) / 100;
		return Math.min(fraction * this.domNode.clientWidth / this.size.width, fraction * this.domNode.clientHeight / this.size.height) || 1;
	}

	private defaultScale(): ImageViewerScale {
		return this.configuration.getValue<'fit' | 'actualSize'>(ImagePreviewConfiguration.defaultZoom) === 'actualSize' ? 1 : 'fit';
	}
}
