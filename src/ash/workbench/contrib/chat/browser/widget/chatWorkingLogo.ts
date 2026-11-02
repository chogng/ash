import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { observeIntersection, observeResize } from '../../../../../base/browser/observer.js';
import { PixelRatio, type IPixelRatioMonitor } from '../../../../../base/browser/pixelRatio.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { acquireChatWorkingLogoAtlas, getChatWorkingLogoAtlasKeyframes } from './chatWorkingLogoAtlas.js';
import { ashTitlebarMark } from '../../../../browser/parts/titlebar/titlebarMark.js';
import { captureChatWorkingLogoDraw, chatWorkingLogoDrawDuration, startChatWorkingLogoDraw } from './chatWorkingLogoDraw.js';
import './media/chatWorkingLogo.css';

/** Decorative working indicator; the caller remains responsible for the accompanying status text. */
export class ChatWorkingLogo extends Disposable {
	/** Hosts may mount this stable root. Content and animation belong to this component until disposal. */
	readonly domNode: HTMLElement;
	private readonly mark: HTMLElement;
	private animations: Animation[] = [];
	private readonly atlasRequest = this._register(new MutableDisposable<DisposableStore>());
	private readonly atlasScheduler = this._register(new RunOnceScheduler(() => { void this.prepareAtlas(); }, 150));
	private readonly pixelRatio: IPixelRatioMonitor | undefined;
	private atlasSheet: HTMLElement | undefined;
	private atlasFailed = false;
	private size = '';
	private active = false;
	private inViewport = true;

	constructor(ownerDocument: Document, @IAccessibilityService private readonly accessibilityService: IAccessibilityService) {
		super();
		this.domNode = h(ownerDocument, 'span');
		this.domNode.className = 'ash-chat-working-logo';
		this.domNode.setAttribute('aria-hidden', 'true');
		this.pixelRatio = ownerDocument.defaultView ? PixelRatio.getInstance(ownerDocument.defaultView) : undefined;
		if (this.pixelRatio) this._register(this.pixelRatio.onDidChange(() => this.invalidateAtlas()));
		this.mark = appendIcon(ashTitlebarMark, this.domNode);
		this._register(toDisposable(() => {
			for (const animation of this.animations) animation.cancel();
			this.animations = [];
			this.domNode.remove();
		}));
		this._register(accessibilityService.onDidChangeReducedMotion(() => this.updateAnimation()));
		this._register(addDisposableListener(ownerDocument, 'visibilitychange', () => this.updateAnimation()));
		this._register(observeIntersection(this.domNode, entry => {
			this.inViewport = entry.isIntersecting;
			this.updateAnimation();
		}));
		this._register(observeResize(this.domNode, ([entry]) => {
			// Hiding the host reports a zero box; keep its paused sheet for the next reveal.
			if (!entry.contentRect.width || !entry.contentRect.height) return;
			const size = `${entry.contentRect.width},${entry.contentRect.height}`;
			if (this.size === size) return;
			this.size = size;
			this.invalidateAtlas();
		}));
	}

	setActive(active: boolean): void {
		this.active = active;
		this.updateAnimation();
	}

	setVisible(visible: boolean): void {
		this.domNode.hidden = !visible;
		this.updateAnimation();
	}

	private updateAnimation(): void {
		if (this.isDisposed) return;
		if (!this.active || this.accessibilityService.isMotionReduced()) {
			this.clearAtlas();
			this.atlasFailed = false;
			for (const animation of this.animations) animation.cancel();
			this.animations = [];
			this.domNode.classList.remove('working');
			return;
		}
		if (this.domNode.hidden || !this.inViewport || this.domNode.ownerDocument.hidden) {
			for (const animation of this.animations) animation.pause();
			if (!this.atlasSheet) this.clearAtlas();
			return;
		}
		if (!this.animations.length && typeof this.mark.getAnimations === 'function') {
			this.domNode.classList.remove('working');
			this.mark.getAnimations({ subtree: true });
			this.domNode.classList.add('working');
			this.animations = startChatWorkingLogoDraw(this.mark);
		}
		for (const animation of this.animations) if (animation.playState === 'paused') animation.play();
		if (!this.atlasRequest.value && !this.atlasFailed && !this.atlasScheduler.isScheduled()) this.atlasScheduler.schedule();
	}

	private invalidateAtlas(): void {
		this.clearAtlas();
		this.atlasFailed = false;
		this.updateAnimation();
	}

	private clearAtlas(): void {
		this.atlasScheduler.cancel();
		this.atlasRequest.clear();
		if (!this.atlasSheet) return;
		for (const animation of this.animations) animation.cancel();
		this.animations = [];
		this.atlasSheet.remove();
		this.atlasSheet = undefined;
		this.domNode.classList.remove('atlas');
	}

	private async prepareAtlas(): Promise<void> {
		const targetWindow = this.domNode.ownerDocument.defaultView;
		if (!targetWindow || this.animations[0]?.playState !== 'running') return;
		const bounds = this.domNode.getBoundingClientRect();
		if (!bounds.width || !bounds.height) return;
		this.size = `${bounds.width},${bounds.height}`;
		const request = new DisposableStore();
		this.atlasRequest.value = request;
		const source = new CancellationTokenSource();
		request.add(toDisposable(() => source.dispose(true)));
		try {
			const ratio = this.pixelRatio?.value ?? 1;
			const reference = request.add(acquireChatWorkingLogoAtlas(targetWindow, {
				width: Math.ceil(bounds.width * ratio), height: Math.ceil(bounds.height * ratio), color: 'white',
				artwork: captureChatWorkingLogoDraw(this.mark, this.animations),
			}));
			const atlas = await raceCancellationError(reference.object, source.token);
			if (this.atlasRequest.value !== request) return;
			const sheet = h(this.domNode.ownerDocument, 'span');
			sheet.className = 'ash-chat-working-logo-atlas';
			// The sheet supplies alpha only; currentColor follows theme changes without rebaking frames.
			sheet.style.maskImage = `url("${atlas.url}")`;
			sheet.style.width = `${atlas.width * bounds.width / atlas.frameWidth}px`;
			sheet.style.height = `${atlas.height * bounds.height / atlas.frameHeight}px`;
			this.domNode.append(sheet);
			request.add(toDisposable(() => sheet.remove()));
			const animation = sheet.animate(getChatWorkingLogoAtlasKeyframes(atlas, bounds.width, bounds.height), {
				duration: chatWorkingLogoDrawDuration, iterations: Infinity,
			});
			animation.currentTime = this.animations[0]?.currentTime ?? 0;
			for (const previous of this.animations) previous.cancel();
			this.animations = [animation];
			this.atlasSheet = sheet;
			this.domNode.classList.add('atlas');
		} catch (error) {
			if (this.atlasRequest.value !== request) return;
			this.clearAtlas();
			if (!isCancellationError(error)) {
				this.atlasFailed = true;
				console.warn('Working logo atlas unavailable; keeping font playback', error);
			}
		}
	}
}
