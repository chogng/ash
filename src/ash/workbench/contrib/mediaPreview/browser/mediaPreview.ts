import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { IEditorPaneWithViewState } from '../../../browser/parts/editor/editorWithViewState.js';
import type { URI } from '../../../../base/common/uri.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { isGitLfsPointer, AUDIO_PREVIEW_EDITOR_ID, VIDEO_PREVIEW_EDITOR_ID } from '../common/mediaPreview.js';
import { MediaPlayerEditorInput } from './mediaPlayerEditorInput.js';
import { reopenInTextEditor } from './mediaPreviewErrors.js';

interface MediaViewState {
	readonly currentTime: number;
	readonly volume: number;
	readonly muted: boolean;
	readonly playbackRate: number;
}

/** Owns playback and its file URL; it never creates a text model for binary media. */
export class MediaPreview extends EditorPane implements IEditorPaneWithViewState {
	public readonly id: string;
	public readonly viewStateTypeId: string;
	private static readonly instances = new WeakMap<HTMLElement, MediaPreview>();
	private readonly source = this._register(new MutableDisposable<IDisposable>());
	private readonly loading = this._register(new MutableDisposable<IDisposable>());
	private readonly playerListeners = this._register(new DisposableStore());
	private domNode!: HTMLElement;
	private viewportDomNode!: HTMLElement;
	private playerDomNode!: HTMLMediaElement;
	private summaryDomNode!: HTMLElement;
	private failureDomNode!: HTMLElement;
	private retryButton!: Button;
	private textButton!: Button;
	private input: MediaPlayerEditorInput | undefined;
	private byteLength = 0;
	private failure: string | undefined;
	private generation = 0;
	private pendingViewState: MediaViewState | undefined;

	constructor(
		private readonly kind: 'audio' | 'video',
		private readonly name: string,
		@IFileService private readonly files: IFileService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEditorService private readonly editors: IEditorService,
	) {
		const id = kind === 'audio' ? AUDIO_PREVIEW_EDITOR_ID : VIDEO_PREVIEW_EDITOR_ID;
		super(id, themeService, storageService);
		this.id = id;
		this.viewStateTypeId = `${id}.viewState`;
	}

	public static getFocused(element: HTMLElement): MediaPreview | undefined {
		const root = element.closest<HTMLElement>('.ash-media-preview');
		return root ? this.instances.get(root) : undefined;
	}

	public override create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview' });
		this.domNode.setAttribute('role', 'region');
		this.domNode.tabIndex = 0;
		this.viewportDomNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-viewport' });
		this.replacePlayer();
		this.summaryDomNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-summary' });
		this.failureDomNode = h(parent.ownerDocument, 'div', { className: 'ash-media-preview-failure' });
		this.failureDomNode.setAttribute('role', 'alert');
		this.failureDomNode.hidden = true;
		this.domNode.append(this.viewportDomNode, this.failureDomNode);
		this.retryButton = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('media.playback.retry', 'Retry'),
			ariaLabel: localize('media.playback.retry', 'Retry'),
			presentation: 'secondary',
			onClick: () => this.retry(),
		}));
		this.retryButton.hidden = true;
		this.textButton = this._register(new Button(this.domNode, {
			...defaultButtonStyles,
			label: localize('mediaPreview.openAsText', 'Open as read-only text'),
			presentation: 'secondary',
			onClick: () => this.openAsText(),
		}));
		this.textButton.hidden = true;
		this.domNode.append(this.summaryDomNode);
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
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('mediaPreview.video')) this.updatePlaybackSettings();
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
			const player = this.playerDomNode;
			const generation = this.generation;
			void player.play().catch(error => {
				if (!this.isCurrentPlayer(player, generation) || !input || this.input !== input || error.name === 'AbortError') { return; }
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
		const viewState = this.input && extUri.isEqual(this.input.resource, input.resource) ? this.saveViewState() : undefined;
		const mediaInput = input instanceof MediaPlayerEditorInput && input.kind === this.kind ? input : new MediaPlayerEditorInput(this.kind, input);
		this.clearInput();
		const generation = this.generation;
		this.replacePlayer();
		this.input = mediaInput;
		this.pendingViewState = viewState ?? undefined;
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => cancellation.abort());
		const combined = AbortSignal.any([signal, cancellation.signal]);
		try {
			const bytes = input.initialBytes ?? (await raceCancellationError(this.files.readFileBytes(input.resource), combined)).bytes;
			combined.throwIfAborted();
			if (!this.isCurrentInput(mediaInput, generation)) { throw new CancellationError(); }
			if (isGitLfsPointer(input.resource, bytes)) {
				throw new Error(localize('mediaPreview.gitLfsPointer', 'This Git revision contains a Git LFS pointer instead of media content. Open it as text to inspect the pointer.'));
			}
			this.byteLength = bytes.length;
			const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: input.contentType ?? '' }));
			const player = this.playerDomNode;
			// Stop the decoder before revoking the URL it is still using.
			this.source.value = toDisposable(() => {
				player.pause();
				player.removeAttribute('src');
				player.load();
				URL.revokeObjectURL(url);
			});
			player.src = url;
			this.updateLabels();
		} catch (error) {
			if (error instanceof CancellationError) {
				if (this.isCurrentInput(mediaInput, generation)) { this.clearInput(); }
				throw error;
			}
			if (!this.isCurrentInput(mediaInput, generation)) { return; }
			this.showLoadFailure(mediaInput, error, generation);
		}
	}

	public override clearInput(): void {
		this.generation++;
		this.loading.clear();
		this.playerListeners.clear();
		this.input = undefined;
		this.pendingViewState = undefined;
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

	public saveViewState(): MediaViewState | null {
		if (this.pendingViewState) { return { ...this.pendingViewState }; }
		if (!this.source.value || this.playerDomNode.readyState < 1 || this.failure !== undefined) { return null; }
		return {
			currentTime: this.playerDomNode.currentTime,
			volume: this.playerDomNode.volume,
			muted: this.playerDomNode.muted,
			playbackRate: this.playerDomNode.playbackRate,
		};
	}

	public restoreViewState(state: unknown): void {
		const restored = parseMediaViewState(state);
		if (!restored || !this.input) { return; }
		this.pendingViewState = restored;
		this.applyViewState();
	}

	public async saveAs(target: URI): Promise<void> {
		if (!this.input) { throw new Error('Media preview has no input'); }
		await this.input.saveAs(target, this.files);
	}

	public getAccessibleContent(): string {
		if (this.failure) { return this.failure; }
		if (!this.input) { return localize('media.playback.empty', 'No media loaded.'); }
		const duration = Number.isFinite(this.playerDomNode.duration)
			? localize('media.playback.duration', '{0} seconds', Math.round(this.playerDomNode.duration * 100) / 100)
			: localize('media.playback.durationUnknown', 'Duration unavailable');
		const state = this.playerDomNode.paused ? localize('media.playback.paused', 'Paused') : localize('media.playback.playing', 'Playing');
		const volume = this.playerDomNode.muted ? localize('media.playback.muted', 'Muted') : `${Math.round(this.playerDomNode.volume * 100)}%`;
		return [
			localize('media.playback.content', '{0}: {1}\nResource: {2}\nFile size: {3} bytes\nDuration: {4}\nPlayback: {5}', this.name, this.input.label ?? basename(this.input.resource), this.input.resource.toString(), this.byteLength, duration, state),
			localize('media.playback.position', 'Position: {0} seconds\nVolume: {1}\nPlayback speed: {2}×', Math.round(this.playerDomNode.currentTime * 100) / 100, volume, this.playerDomNode.playbackRate),
		].join('\n');
	}

	private updateLabels(): void {
		const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.MediaPreview);
		this.domNode.setAttribute('aria-label', [this.name, hint].filter(Boolean).join('. '));
		this.playerDomNode.setAttribute('aria-label', this.input ? `${this.name}: ${this.input.label ?? basename(this.input.resource)}` : this.name);
		this.failureDomNode.hidden = this.failure === undefined;
		this.failureDomNode.textContent = this.failure ?? '';
		this.retryButton.hidden = this.failure === undefined || this.input === undefined;
		this.textButton.hidden = this.retryButton.hidden;
		this.summaryDomNode.textContent = this.input && this.failure === undefined ? localize('media.playback.summary', '{0} · {1} bytes', this.input.label ?? basename(this.input.resource), this.byteLength) : '';
		this.summaryDomNode.title = this.summaryDomNode.textContent;
	}

	private replacePlayer(): void {
		this.playerListeners.clear();
		const player = h(this.viewportDomNode.ownerDocument, this.kind, { className: 'ash-media-preview-player' });
		player.controls = true;
		player.preload = 'metadata';
		player.tabIndex = 0;
		player.setAttribute('aria-label', this.name);
		this.playerDomNode = player;
		this.updatePlaybackSettings();
		this.viewportDomNode.replaceChildren(player);
		const generation = this.generation;
		for (const event of ['loadedmetadata', 'durationchange', 'play', 'pause', 'ended']) {
			this.playerListeners.add(addDisposableListener(player, event, () => {
				if (this.isCurrentPlayer(player, generation)) {
					this.applyViewState();
					this.updateLabels();
				}
			}));
		}
		this.playerListeners.add(addDisposableListener(player, 'error', () => {
			if (!this.isCurrentPlayer(player, generation) || !this.input) { return; }
			this.failure = localize('media.playback.unsupported', 'This media file could not be played. Its data or codec may not be supported.');
			this.updateLabels();
		}));
	}

	private isCurrentPlayer(player: HTMLMediaElement, generation: number): boolean {
		return !this.isDisposed && this.playerDomNode === player && this.generation === generation;
	}

	private applyViewState(): void {
		const state = this.pendingViewState;
		const player = this.playerDomNode;
		if (!state || player.readyState < 1 || !this.source.value) { return; }
		// Seeking must wait for this player's metadata; old players lose their listeners on replacement.
		this.pendingViewState = undefined;
		player.volume = state.volume;
		player.muted = state.muted;
		player.playbackRate = state.playbackRate;
		player.currentTime = Number.isFinite(player.duration) ? Math.min(state.currentTime, player.duration) : state.currentTime;
	}

	private updatePlaybackSettings(): void {
		// Audio keeps explicit playback; these preferences belong to the video preview.
		this.playerDomNode.autoplay = this.kind === 'video' && this.configuration.getValue<boolean>('mediaPreview.video.autoPlay') === true;
		this.playerDomNode.loop = this.kind === 'video' && this.configuration.getValue<boolean>('mediaPreview.video.loop') === true;
	}

	private isCurrentInput(input: IResourceEditorInput, generation: number): boolean {
		return !this.isDisposed && this.input === input && this.generation === generation;
	}

	private showLoadFailure(input: MediaPlayerEditorInput, error: unknown, generation: number): void {
		if (!this.isCurrentInput(input, generation)) { return; }
		const viewState = this.pendingViewState;
		this.clearInput();
		this.input = input;
		this.pendingViewState = viewState;
		this.failure = localize('media.playback.loadFailed', 'Could not load media: {0}', String(error));
		this.updateLabels();
	}

	private retry(): void {
		const input = this.input;
		if (!input || this.failure === undefined) { return; }
		void this.setInput(input, new AbortController().signal).catch(error => {
			if (error instanceof CancellationError || this.isDisposed || this.input !== input) { return; }
			this.showLoadFailure(input, error, this.generation);
		});
	}

	private openAsText(): void {
		const input = this.input;
		const generation = this.generation;
		if (!input || this.failure === undefined) { return; }
		const cancellation = new AbortController();
		this.loading.value = toDisposable(() => cancellation.abort());
		void reopenInTextEditor(input, this.files, this.editors, this.group, cancellation.signal).catch(error => {
			if (cancellation.signal.aborted) { return; }
			if (!this.isCurrentInput(input, generation)) { return; }
			this.failure = localize('mediaPreview.openAsTextFailed', 'Could not open text preview: {0}', error instanceof Error ? error.message : String(error));
			this.updateLabels();
		});
	}
}

function parseMediaViewState(value: unknown): MediaViewState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const state = value as Partial<MediaViewState>;
	if (typeof state.currentTime !== 'number' || !Number.isFinite(state.currentTime) || state.currentTime < 0 ||
		typeof state.volume !== 'number' || !Number.isFinite(state.volume) || state.volume < 0 || state.volume > 1 ||
		typeof state.muted !== 'boolean' || typeof state.playbackRate !== 'number' || !Number.isFinite(state.playbackRate) ||
		state.playbackRate < 0.0625 || state.playbackRate > 16) { return undefined; }
	return { currentTime: state.currentTime, volume: state.volume, muted: state.muted, playbackRate: state.playbackRate };
}
