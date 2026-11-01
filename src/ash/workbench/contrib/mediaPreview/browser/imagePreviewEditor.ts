import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ImageResource } from '../../../../base/browser/image.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { Emitter } from '../../../../base/common/event.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ImageViewer, type IImageViewerViewState } from './imageViewer.js';
import { IMAGE_PREVIEW_EDITOR_ID } from '../common/mediaPreview.js';
import './media/imagePreviewEditor.css';

export class ImagePreviewEditor extends EditorPane implements IEditorPane {
	public readonly id = IMAGE_PREVIEW_EDITOR_ID;
	private static readonly instances = new WeakMap<HTMLElement, ImagePreviewEditor>();
	private readonly resource = this._register(new MutableDisposable<ImageResource>());
	private readonly loading = this._register(new MutableDisposable<IDisposable>());
	private domNode!: HTMLElement;
	private viewer!: ImageViewer;
	private summaryDomNode!: HTMLElement;
	private summaryTextDomNode!: HTMLElement;
	private retryButton!: Button;
	private input: IResourceEditorInput | undefined;
	private mediaType: string | undefined;
	private readonly imageInfoChanged = this._register(new Emitter<void>());
	public readonly onDidChangeImageInfo = this.imageInfoChanged.event;
	private loadFailure: string | undefined;
	private byteLength = 0;
	private generation = 0;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IFileService private readonly files: IFileService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly imageStorage: IStorageService,
	) {
		super(IMAGE_PREVIEW_EDITOR_ID, themeService, imageStorage);
	}

	public static getFocused(element: HTMLElement): ImagePreviewEditor | undefined {
		const root = element.closest<HTMLElement>('.ash-image-preview');
		return root ? this.instances.get(root) : undefined;
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-image-preview' });
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('role', 'region');
		const content = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-content' });
		this.viewer = this._register(this.instantiation.createInstance(ImageViewer, content));
		this._register(this.viewer.onDidChangeScale(() => { this.updateSummary(); this.imageInfoChanged.fire(); }));
		this._register(this.viewer.onDidFailCopy(error => {
			this.summaryDomNode.classList.remove('hidden');
			this.summaryDomNode.setAttribute('role', 'alert');
			this.summaryTextDomNode.textContent = localize('media.image.copyFailed', 'Could not copy image: {0}', error instanceof Error ? error.message : String(error));
		}));
		this.summaryDomNode = h(parent.ownerDocument, 'div', { className: 'ash-image-preview-summary' });
		this.summaryDomNode.setAttribute('role', 'status');
		this.summaryTextDomNode = h(parent.ownerDocument, 'span', { className: 'ash-image-preview-summary-text' });
		this.summaryDomNode.append(this.summaryTextDomNode);
		this.retryButton = this._register(new Button(this.summaryDomNode, {
			...defaultButtonStyles,
			label: localize('media.image.retry', 'Retry'),
			onClick: () => this.retry(),
		}));
		this.retryButton.domNode.classList.add('ash-image-preview-retry');
		this.domNode.append(content, this.summaryDomNode);
		parent.append(this.domNode);
		super.create(this.domNode);
		ImagePreviewEditor.instances.set(this.domNode, this);
		this._register(toDisposable(() => {
			this.clearInput();
			ImagePreviewEditor.instances.delete(this.domNode);
			this.domNode.remove();
		}));
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('imagePreviewFocused', true);
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.updateAriaLabel()));
		this._register(this.files.onDidChangeFiles(event => {
			const input = this.input;
			if (!input || event.resources && !event.resources.some(resource => extUri.isEqual(resource, input.resource))) { return; }
			const reload = this.load(input, new AbortController().signal, false);
			const generation = this.generation;
			void reload.catch(error => {
				if (error instanceof CancellationError || this.isDisposed || generation !== this.generation || this.input !== input) { return; }
				this.failLoad(input, error, generation);
			});
		}));
		this.updateLabels();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.input = input;
		const generation = this.generation + 1;
		try {
			await this.load(input, signal, true);
		} catch (error) {
			if (error instanceof CancellationError) {
				if (this.generation === generation && this.input === input) { this.clearInput(); }
				throw error;
			}
			if (this.isDisposed || this.generation !== generation || this.input !== input) { return; }
			this.failLoad(input, error, generation);
		}
	}

	public override clearInput(): void {
		this.saveViewState();
		this.generation++;
		this.loading.clear();
		this.viewer.clear();
		this.input = undefined;
		this.mediaType = undefined;
		this.loadFailure = undefined;
		this.resource.clear();
		this.summaryTextDomNode.textContent = '';
		this.updateLabels();
	}

	public override layout(_dimension: IDimension): void { this.viewer.layout(); }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		this.domNode.classList.toggle('hidden', !!this.domNode.hidden);
		this.imageInfoChanged.fire();
	}
	public override focus(): void { this.viewer.domNode.focus(); }

	public getAccessibleContent(): string {
		const metadata = this.imageInfo;
		if (!metadata || !this.input) {
			return this.loadFailure === undefined ? localize('media.image.empty', 'No image loaded.') : localize('media.image.loadFailed', 'Could not load image: {0}', this.loadFailure);
		}
		return localize('media.image.content', 'Image: {0}\nResource: {1}\nSize: {2} × {3} pixels\nFormat: {4}\nFile size: {5} bytes\nZoom: {6}', this.input.label ?? basename(this.input.resource), this.input.resource.toString(), metadata.width, metadata.height, metadata.mediaType, this.byteLength, this.zoomLabel());
	}

	private async load(input: IResourceEditorInput, signal: AbortSignal, resetScale: boolean): Promise<void> {
		const generation = ++this.generation;
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => { cancellation.abort(); this.viewer.cancelPendingSource(); });
		const combined = AbortSignal.any([signal, cancellation.signal]);
		throwIfCancelled(combined);
		const bytes = input.initialBytes ?? (await raceCancellationError(this.files.readFileBytes(input.resource), combined)).bytes;
		const mediaType = getMediaMime(input.resource.path) ?? input.contentType?.split(';', 1)[0].trim().toLowerCase() ?? '';
		const resource = new ImageResource(bytes, mediaType);
		let accepted = false;
		try {
			accepted = await raceCancellationError(this.viewer.setSource(resource.url, {
				alt: input.label ?? basename(input.resource),
				viewState: resetScale ? this.readViewState(input) : this.viewer.getViewState(),
				data: { mimeType: mediaType, read: async () => bytes },
			}), combined);
			throwIfCancelled(combined);
		} finally {
			if (!accepted || combined.aborted || this.isDisposed || generation !== this.generation) resource.dispose();
		}
		if (!accepted) throw new CancellationError();
		throwIfCancelled(combined);
		if (generation !== this.generation || this.isDisposed) { throw new CancellationError(); }
		this.resource.value = resource;
		this.mediaType = mediaType;
		this.loadFailure = undefined;
		this.input = input;
		this.byteLength = bytes.length;
		this.updateLabels();
		this.viewer.layout();
		this.imageInfoChanged.fire();
	}

	private failLoad(input: IResourceEditorInput, error: unknown, generation: number): void {
		if (this.isDisposed || this.generation !== generation || this.input !== input) { return; }
		this.clearInput();
		// Retain the resource so the user can retry or see a later file-change recovery.
		this.input = input;
		this.loadFailure = error instanceof Error ? error.message : String(error);
		this.updateLabels();
	}

	private retry(): void {
		const input = this.input;
		if (!input || this.loadFailure === undefined) { return; }
		void this.setInput(input, new AbortController().signal).catch(error => {
			if (error instanceof CancellationError || this.isDisposed || this.input !== input) { return; }
			this.failLoad(input, error, this.generation);
		});
	}

	private updateLabels(): void {
		this.updateAriaLabel();
		const failed = this.loadFailure !== undefined;
		const restoreFocus = !failed && this.retryButton.domNode === this.domNode.ownerDocument.activeElement;
		this.retryButton.domNode.hidden = !failed;
		this.retryButton.domNode.classList.toggle('hidden', !failed);
		if (restoreFocus) this.viewer.domNode.focus();
		this.summaryDomNode.setAttribute('role', this.loadFailure === undefined ? 'status' : 'alert');
		this.updateSummary();
		this.imageInfoChanged.fire();
	}

	private updateAriaLabel(): void {
		const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ImagePreview);
		this.domNode.setAttribute('aria-label', [localize('media.image.preview', 'Image preview'), hint].filter(Boolean).join('. '));
	}

	public get imageViewer(): ImageViewer { return this.viewer; }
	public get fileSize(): number | undefined { return this.viewer.hasImage ? this.byteLength : undefined; }

	/** Current decoded image details, derived from the editor's accepted resource. */
	public get imageInfo(): { readonly name: string; readonly width: number; readonly height: number; readonly mediaType: string; readonly fileSize: number; } | undefined {
		const size = this.viewer.naturalSize;
		return size && this.mediaType && this.input
			? { ...size, name: this.input.label ?? basename(this.input.resource), mediaType: this.mediaType, fileSize: this.byteLength }
			: undefined;
	}

	private zoomLabel(): string {
		return this.viewer.scale === 'fit' ? localize('media.image.fit', 'Fit to window') : `${Math.round(this.viewer.scale * 100)}%`;
	}

	protected override saveState(): void { this.saveViewState(); super.saveState(); }

	protected override disposeCore(): void { this.saveViewState(); super.disposeCore(); }

	private saveViewState(): void {
		if (!this.input || !this.viewer?.hasImage) return;
		const states = this.readViewStates();
		const key = `${this.group?.id ?? 'standalone'}:${this.input.resource}`;
		delete states[key];
		states[key] = this.viewer.getViewState();
		for (const oldest of Object.keys(states).slice(0, -50)) delete states[oldest];
		this.imageStorage.store('imagePreview.viewStates', JSON.stringify(states), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private readViewState(input: IResourceEditorInput): IImageViewerViewState | undefined {
		const saved = this.readViewStates();
		const state = saved[`${this.group?.id ?? 'standalone'}:${input.resource}`] as IImageViewerViewState | undefined;
		if (!state || typeof state !== 'object') return undefined;
		if (state.scale !== 'fit' && (typeof state.scale !== 'number' || !Number.isFinite(state.scale) || state.scale < 0.1 || state.scale > 20)) return undefined;
		return [state.scrollLeft, state.scrollTop].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0) ? state : undefined;
	}

	private readViewStates(): Record<string, unknown> {
		const serialized = this.imageStorage.get('imagePreview.viewStates', StorageScope.WORKSPACE);
		if (!serialized) return {};
		try {
			const state: unknown = JSON.parse(serialized);
			return state && typeof state === 'object' && !Array.isArray(state) ? state as Record<string, unknown> : {};
		} catch { return {}; }
	}

	private updateSummary(): void {
		const summary = this.loadFailure === undefined ? '' : localize('media.image.loadFailed', 'Could not load image: {0}', this.loadFailure);
		this.summaryDomNode.classList.toggle('hidden', !summary);
		this.summaryDomNode.setAttribute('role', this.loadFailure === undefined ? 'status' : 'alert');
		this.summaryTextDomNode.textContent = summary;
		this.summaryDomNode.title = summary;
	}
}
