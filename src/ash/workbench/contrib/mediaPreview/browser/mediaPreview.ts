import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';

export const AUDIO_PREVIEW_ID = 'ash.audioPreview';
export const VIDEO_PREVIEW_ID = 'ash.videoPreview';

/** Owns playback and its file URL; it never creates a text model for binary media. */
export class MediaPreview extends EditorPane {
	public readonly id: string;
	private static readonly instances = new WeakMap<HTMLElement, MediaPreview>();
	private readonly source = this._register(new MutableDisposable<IDisposable>());
	private readonly loading = this._register(new MutableDisposable<IDisposable>());
	private domNode!: HTMLElement;
	private playerDomNode!: HTMLMediaElement;
	private summaryDomNode!: HTMLElement;
	private failureDomNode!: HTMLElement;
	private input: IResourceEditorInput | undefined;
	private byteLength = 0;
	private failure: string | undefined;

	constructor(
		private readonly kind: 'audio' | 'video',
		private readonly name: string,
		@IFileService private readonly files: IFileService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		const id = kind === 'audio' ? AUDIO_PREVIEW_ID : VIDEO_PREVIEW_ID;
		super(id, themeService, storageService);
		this.id = id;
	}

	public static getFocused(element: HTMLElement): MediaPreview | undefined {
		const root = element.closest<HTMLElement>('.ash-media-preview');
		return root ? this.instances.get(root) : undefined;
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview' });
		this.domNode.setAttribute('role', 'region');
		this.domNode.tabIndex = 0;
		const viewport = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-viewport' });
		this.playerDomNode = h(parent.ownerDocument, this.kind, { className: 'ash-media-preview-player' });
		this.playerDomNode.controls = true;
		this.playerDomNode.preload = 'metadata';
		this.playerDomNode.tabIndex = 0;
		this.playerDomNode.setAttribute('aria-label', this.name);
		viewport.append(this.playerDomNode);
		this.summaryDomNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-summary' });
		this.failureDomNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-failure' });
		this.failureDomNode.setAttribute('role', 'alert');
		this.failureDomNode.hidden = true;
		this.domNode.append(viewport, this.failureDomNode, this.summaryDomNode);
		parent.append(this.domNode);
		super.create(this.domNode);
		MediaPreview.instances.set(this.domNode, this);
		this._register(toDisposable(() => {
			this.clearInput();
			MediaPreview.instances.delete(this.domNode);
			this.domNode.remove();
		}));
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('mediaPreviewFocused', true);
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.updateLabels()));
		for (const event of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended']) {
			this._register(addDisposableListener(this.playerDomNode, event, () => this.updateLabels()));
		}
		this._register(addDisposableListener(this.playerDomNode, 'error', () => {
			if (!this.input) { return; }
			this.failure = localize('media.playback.unsupported', 'This media file could not be played. Its data or codec may not be supported.');
			this.updateLabels();
		}));
		// Browser playback controls own their keys; handle Space only on the surrounding region.
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== ' ' || event.ctrlKey || event.metaKey || event.altKey || event.repeat || event.target !== this.domNode || !this.source.value) { return; }
			event.preventDefault();
			event.stopPropagation();
			if (!this.playerDomNode.paused) {
				this.playerDomNode.pause();
				return;
			}
			const input = this.input;
			void this.playerDomNode.play().catch(error => {
				if (this.isDisposed || !input || this.input !== input || error.name === 'AbortError') { return; }
				this.failure = localize('media.playback.failed', 'Could not play media: {0}', String(error));
				this.updateLabels();
			});
		}));
		this._register(this.files.onDidChangeFiles(event => {
			const input = this.input;
			if (!input || event.resources && !event.resources.some(resource => extUri.isEqual(resource, input.resource))) { return; }
			void this.setInput(input, new AbortController().signal).catch(error => {
				if (this.isDisposed || error instanceof CancellationError || this.input !== input) { return; }
				this.failure = localize('media.playback.loadFailed', 'Could not load media: {0}', String(error));
				this.updateLabels();
			});
		}));
		this.updateLabels();
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		this.input = input;
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => cancellation.abort());
		const combined = AbortSignal.any([signal, cancellation.signal]);
		const file = await raceCancellationError(this.files.readFileBytes(input.resource), combined);
		combined.throwIfAborted();
		this.byteLength = file.bytes.length;
		const url = URL.createObjectURL(new Blob([new Uint8Array(file.bytes)], { type: input.contentType ?? '' }));
		// Stop the decoder before revoking the URL it is still using.
		this.source.value = toDisposable(() => {
			this.playerDomNode.pause();
			this.playerDomNode.removeAttribute('src');
			this.playerDomNode.load();
			URL.revokeObjectURL(url);
		});
		this.playerDomNode.src = url;
		this.updateLabels();
	}

	public override clearInput(): void {
		this.loading.clear();
		this.input = undefined;
		this.source.clear();
		this.byteLength = 0;
		this.failure = undefined;
		this.updateLabels();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.domNode.classList.toggle('hidden', !visible);
		if (!visible) { this.playerDomNode.pause(); }
	}

	public override layout(_dimension: IDimension): void { }
	public override focus(): void { this.playerDomNode.focus(); }

	public getAccessibleContent(): string {
		if (this.failure) { return this.failure; }
		if (!this.input) { return localize('media.playback.empty', 'No media loaded.'); }
		const duration = Number.isFinite(this.playerDomNode.duration)
			? localize('media.playback.duration', '{0} seconds', Math.round(this.playerDomNode.duration * 100) / 100)
			: localize('media.playback.durationUnknown', 'Duration unavailable');
		const state = this.playerDomNode.paused ? localize('media.playback.paused', 'Paused') : localize('media.playback.playing', 'Playing');
		return localize('media.playback.content', '{0}: {1}\nResource: {2}\nFile size: {3} bytes\nDuration: {4}\nPlayback: {5}', this.name, this.input.label ?? basename(this.input.resource), this.input.resource.toString(), this.byteLength, duration, state);
	}

	private updateLabels(): void {
		const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.MediaPreview);
		this.domNode.setAttribute('aria-label', [this.name, hint].filter(Boolean).join('. '));
		this.playerDomNode.setAttribute('aria-label', this.input ? `${this.name}: ${this.input.label ?? basename(this.input.resource)}` : this.name);
		this.failureDomNode.hidden = this.failure === undefined;
		this.failureDomNode.textContent = this.failure ?? '';
		this.summaryDomNode.textContent = this.input ? localize('media.playback.summary', '{0} · {1} bytes', this.input.label ?? basename(this.input.resource), this.byteLength) : '';
		this.summaryDomNode.title = this.summaryDomNode.textContent;
	}
}
