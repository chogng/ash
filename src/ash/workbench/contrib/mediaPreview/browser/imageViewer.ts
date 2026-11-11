import './media/imageViewer.css';
import { addDisposableListener, getWindow, h } from '../../../../base/browser/dom.js';
import { GlobalPointerMoveMonitor } from '../../../../base/browser/globalPointerMoveMonitor.js';
import { StandardWheelEvent } from '../../../../base/browser/mouseEvent.js';
import { AnimationFrameScheduler } from '../../../../base/browser/scheduler.js';
import { animateElement } from '../../../../base/browser/ui/animations/animations.js';
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
	readonly data?: { readonly mimeType: string; read(): Promise<Uint8Array>; };
	/** Side from which the decoded image enters during gallery navigation. */
	readonly slideFrom?: 'left' | 'right';
}

const zoomLevels = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20];

interface WheelZoomAxis {
	readonly viewport: number;
	readonly scroll: number;
	readonly start: number;
	zoomedStart: number;
}

function captureWheelZoomAxis(viewport: number, scroll: number, scaledSize: number): WheelZoomAxis {
	const start = Math.max(0, (viewport - scaledSize) / 2) - scroll;
	return { viewport, scroll, start, zoomedStart: start };
}

/** Keep the point under the pointer fixed as far as the viewport permits. */
function zoomAround(axis: WheelZoomAxis, anchor: number, ratio: number, scaledSize: number): void {
	axis.zoomedStart = scaledSize <= axis.viewport
		? (axis.viewport - scaledSize) / 2
		: clamp(anchor + (axis.zoomedStart - anchor) * ratio, axis.viewport - scaledSize, 0);
}

/** Owns image geometry, scrolling and input; its host owns the source URL and placement. */
export class ImageViewer extends Disposable {
	/** Mounting surface. Hosts may place and size it, but must use semantic methods for content. */
	public readonly domNode: HTMLElement;
	private readonly imageDomNode: HTMLImageElement;
	private readonly media: HTMLElement;
	private readonly pending = this._register(new MutableDisposable());
	private readonly sourceTransition = this._register(new MutableDisposable());
	private readonly wheelZoomFrame: AnimationFrameScheduler;
	private readonly wheelZoomIdle = this._register(new RunOnceScheduler(() => this.finishWheelZoom(), 120));
	private wheelZoom: { readonly baseScale: number; readonly x: WheelZoomAxis; readonly y: WheelZoomAxis; scale: number; } | undefined;
	private readonly pan: GlobalPointerMoveMonitor | undefined;
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
		options: { readonly contextMenu?: boolean; readonly overlay?: SVGSVGElement; readonly wheelZoom?: boolean; readonly dragPan?: boolean; },
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
		this.wheelZoomFrame = this._register(new AnimationFrameScheduler(getWindow(this.domNode), () => this.renderWheelZoom()));
		this.pan = options.dragPan ? this._register(new GlobalPointerMoveMonitor()) : undefined;
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
			if (!options.wheelZoom && !event.ctrlKey && !(isMacintosh && event.altKey)) {
				this.finishWheelZoom();
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			if (!this.hasImage || this.pan?.isMonitoring()) return;
			const { deltaY } = new StandardWheelEvent(event, { pageHeight: this.domNode.clientHeight });
			if (deltaY === 0) return;
			if (options.wheelZoom) {
				const bounds = this.domNode.getBoundingClientRect();
				this.queueWheelZoom(deltaY, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
			} else if (event.ctrlKey) this.queueWheelZoom(deltaY);
			else if (deltaY < 0) this.zoomIn();
			else this.zoomOut();
		}, { passive: false }));
		this._register(addDisposableListener(this.domNode, 'scroll', () => {
			const zoom = this.wheelZoom;
			if (zoom && (zoom.x.scroll !== this.domNode.scrollLeft || zoom.y.scroll !== this.domNode.scrollTop)) this.finishWheelZoom();
		}));
		let clickCanZoom = false;
		const pan = this.pan;
		if (pan) {
			this._register(addDisposableListener(this.domNode, 'pointerdown', event => {
				// The annotation overlay claims drawing before the event reaches the viewer.
				if (event.defaultPrevented || event.button !== 0 || event.pointerType !== 'mouse' || (isMacintosh && event.ctrlKey)) return;
				this.finishWheelZoom();
				if (!this.canPan()) return;
				const { clientX, clientY } = event;
				const { scrollLeft, scrollTop } = this.domNode;
				let dragging = false;
				pan.startMonitoring(this.domNode, event.pointerId, event.buttons, move => {
					const dx = move.clientX - clientX;
					const dy = move.clientY - clientY;
					if (!dragging) {
						if (Math.max(Math.abs(dx), Math.abs(dy)) < 4) return;
						dragging = true;
						clickCanZoom = false;
						this.domNode.classList.add('panning');
					}
					this.domNode.scrollLeft = scrollLeft - dx;
					this.domNode.scrollTop = scrollTop - dy;
				}, () => this.domNode.classList.remove('panning'), event.pointerType);
			}));
		}
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
			} else if (!(pan && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && this.panWithArrow(event.key))) return;
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
			this.cancelWheelZoom();
			this.pan?.stopMonitoring(true);
			this.size = { width: probe.naturalWidth, height: probe.naturalHeight };
			this.sourceData = options.data;
			this.imageDomNode.src = src;
			this.imageDomNode.alt = options.alt;
			this.currentScale = options.viewState?.scale ?? this.defaultScale();
			this.domNode.classList.add('ready');
			this.layout();
			this.domNode.scrollLeft = options.viewState?.scrollLeft ?? 0;
			this.domNode.scrollTop = options.viewState?.scrollTop ?? 0;
			if (options.slideFrom) {
				const offset = options.slideFrom === 'left' ? -10 : 10;
				const animation = animateElement(this.imageDomNode, [
					{ transform: `translateX(${offset}px)`, opacity: 0.88 },
					{ transform: 'translateX(0)', opacity: 1 },
				], { fill: 'none' });
				if (animation) this.sourceTransition.value = toDisposable(() => animation.cancel());
			}
			this.scaleChanged.fire(this.scale);
			return true;
		} catch (error) {
			if (this.isDisposed || generation !== this.generation) return false;
			throw new TypeError(localize('media.image.invalid', 'The image data could not be decoded.'), { cause: error });
		} finally {
			if (generation === this.generation) this.pending.clear();
		}
	}

	public cancelPendingSource(): void {
		this.generation++;
		this.pending.clear();
		this.sourceTransition.clear();
	}

	public clear(): void {
		this.cancelPendingSource();
		this.cancelWheelZoom();
		this.pan?.stopMonitoring(true);
		this.size = undefined;
		this.sourceData = undefined;
		this.currentScale = 'fit';
		this.domNode.classList.remove('ready', 'pannable');
		this.imageDomNode.removeAttribute('src');
		this.imageDomNode.alt = '';
	}

	public getViewState(): IImageViewerViewState {
		const zoom = this.wheelZoom;
		if (zoom) {
			return {
				scale: zoom.scale,
				scrollLeft: Math.max(0, -zoom.x.zoomedStart),
				scrollTop: Math.max(0, -zoom.y.zoomedStart),
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
		const zoom = this.wheelZoom;
		this.cancelWheelZoom();
		if (!this.size) return;
		this.pan?.stopMonitoring(true);
		const previous = zoom?.scale ?? this.effectiveScale();
		const { clientWidth, clientHeight, scrollLeft, scrollTop } = this.domNode;
		const offsetX = zoom ? zoom.x.scroll + zoom.x.zoomedStart : 0;
		const offsetY = zoom ? zoom.y.scroll + zoom.y.zoomedStart : 0;
		this.currentScale = scale === 'fit' ? scale : clamp(scale, 0.1, 20);
		this.layout();
		const next = this.effectiveScale();
		const ratio = next / previous;
		// Committing a wheel zoom keeps its viewport coordinates even if a scrollbar appears.
		const committingWheelZoom = zoom?.scale === scale;
		const nextWidth = committingWheelZoom ? clientWidth : this.domNode.clientWidth;
		const nextHeight = committingWheelZoom ? clientHeight : this.domNode.clientHeight;
		this.domNode.scrollLeft = Math.max(0, (scrollLeft - offsetX + clientWidth / 2) * ratio - nextWidth / 2);
		this.domNode.scrollTop = Math.max(0, (scrollTop - offsetY + clientHeight / 2) * ratio - nextHeight / 2);
		this.scaleChanged.fire(this.scale);
	}

	public zoomIn(): void {
		const scale = this.wheelZoom?.scale ?? this.effectiveScale();
		// A tiny fitted image can already exceed the manual zoom limit.
		if (scale >= 20) return;
		this.setScale(zoomLevels.find(level => level > scale + 0.0001) ?? 20);
	}
	public zoomOut(): void {
		const scale = this.wheelZoom?.scale ?? this.effectiveScale();
		this.setScale([...zoomLevels].reverse().find(level => level < scale - 0.0001) ?? 0.1);
	}

	public layout(): void {
		if (!this.size) return;
		if (this.wheelZoom) {
			this.finishWheelZoom();
			return;
		}
		const scale = this.effectiveScale();
		this.imageDomNode.style.width = `${this.size.width * scale}px`;
		this.imageDomNode.style.height = `${this.size.height * scale}px`;
		this.imageDomNode.classList.toggle('pixelated', scale >= 3 && this.sourceData?.mimeType !== 'image/svg+xml');
		if (this.pan) this.domNode.classList.toggle('pannable', this.canPan());
		this.displayScaleChanged.fire(scale);
	}

	private canPan(): boolean {
		const { scrollWidth, clientWidth, scrollHeight, clientHeight } = this.domNode;
		return this.hasImage && (scrollWidth > clientWidth || scrollHeight > clientHeight);
	}

	private panWithArrow(key: string): boolean {
		const step = 40;
		let dx = 0;
		let dy = 0;
		switch (key) {
			case 'ArrowLeft': dx = -step; break;
			case 'ArrowRight': dx = step; break;
			case 'ArrowUp': dy = -step; break;
			case 'ArrowDown': dy = step; break;
			default: return false;
		}
		this.finishWheelZoom();
		if (!this.canPan()) return false;
		this.domNode.scrollBy(dx, dy);
		return true;
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

	private queueWheelZoom(deltaY: number, anchor?: { readonly x: number; readonly y: number; }): void {
		const size = this.size;
		if (!size) return;
		let zoom = this.wheelZoom;
		const previous = zoom?.scale ?? this.effectiveScale();
		const scale = clamp(previous * Math.exp(-deltaY / 100), 0.1, 20);
		// Hold the native scroll geometry fixed until wheel or pinch input settles.
		if (!zoom) {
			// Fit can exceed the manual range. A gesture must still move in the requested direction.
			if (deltaY < 0 ? scale <= previous : scale >= previous) return;
			zoom = this.wheelZoom = {
				baseScale: previous,
				x: captureWheelZoomAxis(this.domNode.clientWidth, this.domNode.scrollLeft, size.width * previous),
				y: captureWheelZoomAxis(this.domNode.clientHeight, this.domNode.scrollTop, size.height * previous),
				scale: previous,
			};
			this.media.style.willChange = 'transform';
		}
		if (scale !== previous) {
			const ratio = scale / previous;
			zoomAround(zoom.x, anchor?.x ?? zoom.x.viewport / 2, ratio, size.width * scale);
			zoomAround(zoom.y, anchor?.y ?? zoom.y.viewport / 2, ratio, size.height * scale);
			zoom.scale = scale;
			this.wheelZoomFrame.schedule();
		}
		this.wheelZoomIdle.schedule();
	}

	private renderWheelZoom(): void {
		const zoom = this.wheelZoom;
		if (!zoom) return;
		const x = zoom.x.zoomedStart - zoom.x.start;
		const y = zoom.y.zoomedStart - zoom.y.start;
		this.media.style.transform = `translate(${x}px, ${y}px) scale(${zoom.scale / zoom.baseScale})`;
		this.displayScaleChanged.fire(zoom.scale);
	}

	private finishWheelZoom(): void {
		if (this.wheelZoom) this.setScale(this.wheelZoom.scale);
	}

	private cancelWheelZoom(): void {
		this.wheelZoomFrame.cancel();
		this.wheelZoomIdle.cancel();
		if (this.wheelZoom) {
			this.wheelZoom = undefined;
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
