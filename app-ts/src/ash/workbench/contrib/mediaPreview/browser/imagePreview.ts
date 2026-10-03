import { addDisposableListener, getWindow, h, type IDimension } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import type { IAction } from '../../../../base/common/actions.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ImageResource, inspectImage, type ImageMetadata } from '../../../../platform/media/browser/image.js';
import { EditorPaneMatch, EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';

export const IMAGE_PREVIEW_ID = 'ash.imagePreview';

export function matchImagePreview(input: EditorInput): EditorPaneMatch {
	const mediaType = input.contentType?.split(';', 1)[0].trim().toLowerCase();
	return /\.(png|jpe?g|webp)$/i.test(input.resource.path) || mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp'
		? EditorPaneMatch.Default
		: EditorPaneMatch.None;
}

export class ImagePreview extends Disposable implements IEditorPane {
	public readonly id = IMAGE_PREVIEW_ID;
	private static readonly instances = new WeakMap<HTMLElement, ImagePreview>();
	private readonly resource = this._register(new MutableDisposable<ImageResource>());
	private readonly loading = this._register(new MutableDisposable<IDisposable>());
	private domNode!: HTMLElement;
	private viewportDomNode!: HTMLElement;
	private imageDomNode!: HTMLImageElement;
	private summaryDomNode!: HTMLElement;
	private toolbar!: WorkbenchToolBar;
	private input: EditorInput | undefined;
	private metadata: ImageMetadata | undefined;
	private loadFailure: string | undefined;
	private byteLength = 0;
	private generation = 0;
	private scale: number | 'fit' = 'fit';

	constructor(
		@IFileService private readonly files: IFileService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
	) {
		super();
	}

	public static getFocused(element: HTMLElement): ImagePreview | undefined {
		const root = element.closest<HTMLElement>('.ash-image-preview');
		return root ? this.instances.get(root) : undefined;
	}

	public create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-image-preview' });
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'region');
		const controls = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-controls' });
		this.viewportDomNode = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-viewport' });
		this.viewportDomNode.tabIndex = 0;
		const stage = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-stage' });
		this.imageDomNode = h(parent.ownerDocument, 'img', { className: 'ash-image-preview-image' });
		this.imageDomNode.draggable = false;
		stage.append(this.imageDomNode);
		this.viewportDomNode.append(stage);
		this.summaryDomNode = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-summary' });
		this.summaryDomNode.setAttribute('role', 'status');
		this.domNode.append(controls, this.viewportDomNode, this.summaryDomNode);
		parent.append(this.domNode);
		ImagePreview.instances.set(this.domNode, this);
		this._register(toDisposable(() => {
			this.clearInput();
			ImagePreview.instances.delete(this.domNode);
			this.domNode.remove();
		}));
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('imagePreviewFocused', true);
		this.toolbar = this._register(new WorkbenchToolBar(controls, this.contextMenus));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === '+' || event.key === '=') { this.zoom(1.25); }
			else if (event.key === '-') { this.zoom(0.8); }
			else if (event.key === '0') { this.setScale('fit'); }
			else if (event.key === '1') { this.setScale(1); }
			else { return; }
			event.preventDefault();
			event.stopPropagation();
		}));
		const observer = new (getWindow(this.domNode).ResizeObserver)(() => this.updateImageGeometry());
		observer.observe(this.viewportDomNode);
		this._register(toDisposable(() => observer.disconnect()));
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.updateAriaLabel()));
		this._register(this.files.onDidChangeFiles(event => {
			const input = this.input;
			if (!input || event.resources && !event.resources.some(resource => extUri.isEqual(resource, input.resource))) { return; }
			const reload = this.load(input, new AbortController().signal, false);
			const generation = this.generation;
			void reload.catch(error => {
				if (error instanceof CancellationError || this.isDisposed || generation !== this.generation) { return; }
				this.clearInput();
				// Keep the open resource subscribed so a later file change can restore the preview.
				this.input = input;
				this.loadFailure = error instanceof Error ? error.message : String(error);
				this.updateLabels();
			});
		}));
		this.updateLabels();
	}

	public async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		await this.load(input, signal, true);
	}

	public clearInput(): void {
		this.generation++;
		this.loading.clear();
		this.input = undefined;
		this.metadata = undefined;
		this.loadFailure = undefined;
		this.imageDomNode.removeAttribute('src');
		this.imageDomNode.alt = '';
		this.resource.clear();
		this.summaryDomNode.textContent = '';
		this.updateLabels();
	}

	public layout(_dimension: IDimension): void { this.updateImageGeometry(); }
	public setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.domNode.classList.toggle('hidden', this.domNode.hidden);
	}
	public focus(): void { this.viewportDomNode.focus(); }

	public getAccessibleContent(): string {
		const metadata = this.metadata;
		if (!metadata || !this.input) {
			return this.loadFailure === undefined ? localize('media.image.empty', 'No image loaded.') : localize('media.image.loadFailed', 'Could not load image: {0}', this.loadFailure);
		}
		return localize('media.image.content', 'Image: {0}\nResource: {1}\nSize: {2} × {3} pixels\nFormat: {4}\nFile size: {5} bytes\nZoom: {6}', this.input.label ?? basename(this.input.resource), this.input.resource.toString(), metadata.width, metadata.height, metadata.mediaType, this.byteLength, this.zoomLabel());
	}

	private async load(input: EditorInput, signal: AbortSignal, resetScale: boolean): Promise<void> {
		const generation = ++this.generation;
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => cancellation.abort());
		const combined = AbortSignal.any([signal, cancellation.signal]);
		throwIfCancelled(combined);
		const file = await raceCancellationError(this.files.readFileBytes(input.resource), combined);
		const metadata = await raceCancellationError(inspectImage(file.bytes), combined);
		throwIfCancelled(combined);
		if (generation !== this.generation || this.isDisposed) { throw new CancellationError(); }
		this.resource.value = new ImageResource(file.bytes, metadata.mediaType);
		this.metadata = metadata;
		this.loadFailure = undefined;
		this.input = input;
		this.byteLength = file.bytes.length;
		if (resetScale) { this.scale = 'fit'; }
		this.imageDomNode.src = this.resource.value.url;
		this.updateLabels();
		this.updateImageGeometry();
	}

	private updateLabels(): void {
		this.updateAriaLabel();
		this.toolbar.element.setAttribute('aria-label', localize('media.image.actions', 'Image preview controls'));
		this.viewportDomNode.setAttribute('aria-label', localize('media.image.viewport', 'Image viewport'));
		this.imageDomNode.alt = this.input?.label ?? (this.input ? basename(this.input.resource) : '');
		const action = (id: string, label: string, run: () => void): IAction => ({ id, label, tooltip: label, enabled: this.metadata !== undefined, run });
		this.toolbar.setActions([
			action('imagePreview.fit', localize('media.image.fit', 'Fit to window'), () => this.setScale('fit')),
			action('imagePreview.actualSize', localize('media.image.actualSize', 'Actual size'), () => this.setScale(1)),
			action('imagePreview.zoomOut', localize('media.image.zoomOut', 'Zoom out'), () => this.zoom(0.8)),
			action('imagePreview.zoomIn', localize('media.image.zoomIn', 'Zoom in'), () => this.zoom(1.25)),
		]);
		this.updateSummary();
	}

	private updateAriaLabel(): void {
		const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ImagePreview);
		this.domNode.setAttribute('aria-label', [localize('media.image.preview', 'Image preview'), hint].filter(Boolean).join('. '));
	}

	private zoom(factor: number): void {
		this.setScale(Math.min(16, Math.max(0.01, this.effectiveScale() * factor)));
	}

	private setScale(scale: number | 'fit'): void {
		this.scale = scale;
		this.updateImageGeometry();
	}

	private effectiveScale(): number {
		if (this.scale !== 'fit' || !this.metadata) { return this.scale === 'fit' ? 1 : this.scale; }
		return Math.min(1, this.viewportDomNode.clientWidth / this.metadata.width, this.viewportDomNode.clientHeight / this.metadata.height);
	}

	private zoomLabel(): string {
		return this.scale === 'fit' ? localize('media.image.fit', 'Fit to window') : `${Math.round(this.scale * 100)}%`;
	}

	private updateImageGeometry(): void {
		if (!this.metadata) { return; }
		const scale = this.effectiveScale();
		this.imageDomNode.style.width = `${this.metadata.width * scale}px`;
		this.imageDomNode.style.height = `${this.metadata.height * scale}px`;
		this.updateSummary();
	}

	private updateSummary(): void {
		const metadata = this.metadata;
		let summary = '';
		if (metadata) {
			summary = localize('media.image.summary', '{0} × {1} pixels · {2} bytes · {3}', metadata.width, metadata.height, this.byteLength, this.zoomLabel());
		} else if (this.loadFailure !== undefined) {
			summary = localize('media.image.loadFailed', 'Could not load image: {0}', this.loadFailure);
		}
		this.summaryDomNode.textContent = summary;
		this.summaryDomNode.title = this.summaryDomNode.textContent;
	}
}
