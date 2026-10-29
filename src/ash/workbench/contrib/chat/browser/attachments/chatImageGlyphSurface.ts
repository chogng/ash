import { addDisposableListener, getWindow, scheduleAtNextAnimationFrame } from '../../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { ITextureRevealOptions, ITextureRevealTiming } from './chatImageTextures.js';

/** Owns one canvas and frame request, including when the loading surface moves into the result. */
export class GlyphSurface extends Disposable {
	readonly canvas: HTMLCanvasElement;
	private readonly frame = this._register(new MutableDisposable());
	private visible = true;
	private loadingTime = 0;
	private revealState: { readonly options: ITextureRevealOptions; readonly clock: Animation } | undefined;

	constructor(
		container: HTMLElement,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IThemeService private readonly themes: IThemeService,
	) {
		super();
		this.canvas = container.ownerDocument.createElement('canvas');
		this.canvas.className = 'ash-chat-image-glyphs';
		this.canvas.setAttribute('aria-hidden', 'true');
		container.append(this.canvas);
		const window = getWindow(container);
		const observer = new window.ResizeObserver(() => this.schedule());
		observer.observe(this.canvas);
		this._register(
			toDisposable(() => {
				observer.disconnect();
				this.revealState?.clock.cancel();
				this.canvas.remove();
				this.canvas.width = this.canvas.height = 0;
			}),
		);
		this._register(accessibility.onDidChangeReducedMotion(() => this.schedule()));
		this._register(themes.onDidColorThemeChange(() => this.schedule()));
		this._register(addDisposableListener(window.document, 'visibilitychange', () => this.schedule()));
		this.schedule();
	}

	getRevealTiming(_fromWidth: number): ITextureRevealTiming {
		return { loadingTime: this.loadingTime, pace: { duration: 700 } };
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.frame.clear();
		if (visible) this.schedule();
	}

	reveal(options: ITextureRevealOptions): void {
		this.revealState?.clock.cancel();
		this.revealState = {
			options,
			clock: this.canvas.animate([], { duration: options.duration, fill: 'forwards' }),
		};
		this.paint();
	}

	private schedule(): void {
		if (this.isDisposed || !this.visible) return;
		this.frame.value = scheduleAtNextAnimationFrame(getWindow(this.canvas), () => this.paint());
	}

	private paint(): void {
		this.frame.clear();
		const window = getWindow(this.canvas);
		if (this.isDisposed || !this.visible || !this.canvas.isConnected || window.document.hidden) return;
		const theme = this.themes.getColorTheme().colorScheme;
		const animated = !this.accessibility.isMotionReduced() && theme !== ColorScheme.HighContrastDark && theme !== ColorScheme.HighContrastLight;
		const reveal = this.revealState;
		const progress = reveal ? Math.min(1, Number(reveal.clock.currentTime ?? 0) / reveal.options.duration) : 0;
		const eased = progress * progress * (3 - 2 * progress);
		const width = reveal ? reveal.options.fromWidth + (reveal.options.samples.width - reveal.options.fromWidth) * eased : this.canvas.clientWidth;
		const height = reveal ? reveal.options.fromHeight + (reveal.options.samples.height - reveal.options.fromHeight) * eased : this.canvas.clientHeight;
		if (!width || !height) return;
		const ratio = Math.min(2, window.devicePixelRatio || 1);
		const pixelWidth = Math.round(width * ratio);
		const pixelHeight = Math.round(height * ratio);
		if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
		if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
		const context = this.canvas.getContext('2d');
		if (!context) return;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		context.clearRect(0, 0, width, height);
		const style = window.getComputedStyle(this.canvas);
		context.font = `10px ${style.fontFamily}`;
		context.textBaseline = 'middle';
		const time = reveal?.options.timing.loadingTime ?? (animated ? window.performance.now() : 0);
		this.loadingTime = time;
		for (let y = 6; y < height; y += 12)
			for (let x = 6; x < width; x += 10) {
				const wave = (Math.sin(x / 24 - time / 260) + Math.cos(y / 31 + time / 410) + 2) / 4;
				context.globalAlpha = 0.2 + wave * 0.8;
				context.fillStyle = reveal && progress > 0 ? reveal.options.samples.colorAt(x / width, y / height) : style.color;
				context.fillText('01·:+*#'[Math.floor((x + y) / 10 + wave * 6) % 7]!, x, y);
			}
		if (reveal) reveal.options.onFrame({ width, height, imageOpacity: eased, textureOpacity: 1 - eased });
		if (animated && (!reveal || progress < 1)) this.schedule();
	}
}
