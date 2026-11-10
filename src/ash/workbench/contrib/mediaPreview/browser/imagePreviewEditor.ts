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
import type { IEditorPaneWithViewState } from '../../../browser/parts/editor/editorWithViewState.js';
import { Emitter } from '../../../../base/common/event.js';
import { getMediaMime } from '../../../../base/common/mime.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ImageViewer, type IImageViewerViewState } from './imageViewer.js';
import { IMAGE_PREVIEW_EDITOR_ID, isGitLfsPointer } from '../common/mediaPreview.js';
import type { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ImagePreviewEditorInput } from './imagePreviewEditorInput.js';
import { reopenInTextEditor } from './mediaPreviewErrors.js';
import './media/imagePreviewEditor.css';

export class ImagePreviewEditor extends EditorPane implements IEditorPane, IEditorPaneWithViewState {
	public readonly id = IMAGE_PREVIEW_EDITOR_ID;
	public readonly viewStateTypeId = 'ash.imagePreview.viewState';
	private static readonly instances = new WeakMap<HTMLElement, ImagePreviewEditor>();
	private readonly resource = this._register(new MutableDisposable<ImageResource>());
	private readonly loading = this._register(new MutableDisposable<IDisposable>());
	private domNode!: HTMLElement;
	private viewer!: ImageViewer;
	private summaryDomNode!: HTMLElement;
	private summaryTextDomNode!: HTMLElement;
	private retryButton!: Button;
	private textButton!: Button;
	private input: ImagePreviewEditorInput | undefined;
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
		@IEditorService private readonly editors: IEditorService,
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
		this.viewer = this._register(this.instantiation.createInstance(ImageViewer, content, {}));
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
		this.textButton = this._register(new Button(this.summaryDomNode, {
			...defaultButtonStyles,
			label: localize('mediaPreview.openAsText', 'Open as read-only text'),
			onClick: () => this.openAsText(),
		}));
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
		const imageInput = input instanceof ImagePreviewEditorInput ? input : new ImagePreviewEditorInput(input);
		this.input = imageInput;
		const generation = this.generation + 1;
		try {
			await this.load(imageInput, signal, true);
		} catch (error) {
			if (error instanceof CancellationError) {
				if (this.generation === generation && this.input === imageInput) { this.clearInput(); }
				throw error;
			}
			if (this.isDisposed || this.generation !== generation || this.input !== imageInput) { return; }
			this.failLoad(imageInput, error, generation);
		}
	}

	public override clearInput(): void {
		this.storeViewState();
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
	public override focus(): void { this.viewer.domNode.focus({ preventScroll: true }); }

	public async saveAs(target: URI): Promise<void> {
		if (!this.input) { throw new Error('Image preview has no input'); }
		await this.input.saveAs(target, this.files);
	}

	public getAccessibleContent(): string {
		const metadata = this.imageInfo;
		if (!metadata || !this.input) {
			return this.loadFailure === undefined ? localize('media.image.empty', 'No image loaded.') : localize('media.image.loadFailed', 'Could not load image: {0}', this.loadFailure);
		}
		return localize('media.image.content', 'Image: {0}\nResource: {1}\nSize: {2} × {3} pixels\nFormat: {4}\nFile size: {5} bytes\nZoom: {6}', this.input.label ?? basename(this.input.resource), this.input.resource.toString(), metadata.width, metadata.height, metadata.mediaType, this.byteLength, this.zoomLabel());
	}

	private async load(input: ImagePreviewEditorInput, signal: AbortSignal, resetScale: boolean): Promise<void> {
		const generation = ++this.generation;
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => { cancellation.abort(); this.viewer.cancelPendingSource(); });
		const combined = AbortSignal.any([signal, cancellation.signal]);
		throwIfCancelled(combined);
		const bytes = input.initialBytes ?? (await raceCancellationError(this.files.readFileBytes(input.resource), combined)).bytes;
		throwIfCancelled(combined);
		if (isGitLfsPointer(input.resource, bytes)) {
			throw new Error(localize('mediaPreview.gitLfsPointer', 'This Git revision contains a Git LFS pointer instead of media content. Open it as text to inspect the pointer.'));
		}
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

	private failLoad(input: ImagePreviewEditorInput, error: unknown, generation: number): void {
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

	private openAsText(): void {
		const input = this.input;
		const generation = this.generation;
		if (!input || this.loadFailure === undefined) { return; }
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => cancellation.abort());
		void reopenInTextEditor(input, this.files, this.editors, this.group, cancellation.signal).catch(error => {
			if (cancellation.signal.aborted) { return; }
			if (this.isDisposed || this.input !== input || this.generation !== generation) { return; }
			this.loadFailure = localize('mediaPreview.openAsTextFailed', 'Could not open text preview: {0}', error instanceof Error ? error.message : String(error));
			this.updateLabels();
		});
	}

	private updateLabels(): void {
		this.updateAriaLabel();
		const failed = this.loadFailure !== undefined;
		const focused = this.domNode.ownerDocument.activeElement;
		const restoreFocus = !failed && (focused === this.retryButton.domNode || focused === this.textButton.domNode);
		this.retryButton.domNode.hidden = !failed;
		this.retryButton.domNode.classList.toggle('hidden', !failed);
		this.textButton.hidden = !failed;
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

	public saveViewState(): IImageViewerViewState | null {
		return this.viewer?.hasImage ? this.viewer.getViewState() : null;
	}

	public restoreViewState(state: unknown): void {
		const viewState = parseImageViewState(state);
		if (viewState && this.viewer.hasImage) {
			this.viewer.restoreViewState(viewState);
		}
	}

	protected override saveState(): void { this.storeViewState(); super.saveState(); }

	protected override disposeCore(): void { this.storeViewState(); super.disposeCore(); }

	private storeViewState(): void {
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
		return parseImageViewState(saved[`${this.group?.id ?? 'standalone'}:${input.resource}`]);
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

/** State can come from workspace storage or another editor host. */
function parseImageViewState(value: unknown): IImageViewerViewState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const state = value as Partial<IImageViewerViewState>;
	if (state.scale !== 'fit' && (typeof state.scale !== 'number' || !Number.isFinite(state.scale) || state.scale < 0.1 || state.scale > 20)) { return undefined; }
	if (typeof state.scrollLeft !== 'number' || !Number.isFinite(state.scrollLeft) || state.scrollLeft < 0 ||
		typeof state.scrollTop !== 'number' || !Number.isFinite(state.scrollTop) || state.scrollTop < 0) { return undefined; }
	return { scale: state.scale, scrollLeft: state.scrollLeft, scrollTop: state.scrollTop };
}
