import { getWindow } from '../../../../../base/browser/dom.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { GlyphSurface } from './chatImageGlyphSurface.js';
import { ImageSamples } from './chatImageTextures.js';
import './chatImageReveal.css';

export interface IChatImageRevealOrigin {
	readonly container: HTMLElement;
	readonly size?: number;
	readonly takeSurface?: () => GlyphSurface | undefined;
}

/** Keeps the live placeholder until decoding finishes, then hands its canvas to the image frame. */
export class ChatImageReveal extends Disposable {
	private readonly effects = this._register(new DisposableStore());
	private started = false;
	private finished = false;

	constructor(
		private readonly container: HTMLElement,
		private readonly image: HTMLImageElement,
		private readonly origin: IChatImageRevealOrigin,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IThemeService private readonly themes: IThemeService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		container.classList.add('ash-chat-image-reveal', 'pending');
		this.effects.add(
			toDisposable(() => {
				this.finished = true;
				container.classList.remove('pending', 'revealing');
				container.style.removeProperty('width');
				container.style.removeProperty('height');
				image.style.removeProperty('opacity');
				origin.container.hidden = true;
			}),
		);
		this.effects.add(
			accessibility.onDidChangeReducedMotion(() => {
				if (!this.motionEnabled) this.effects.clear();
			}),
		);
		this.effects.add(
			themes.onDidColorThemeChange(() => {
				if (!this.motionEnabled) this.effects.clear();
			}),
		);
	}

	reveal(loadedAt = getWindow(this.container).performance.now()): void {
		if (this.started || this.finished || this.isDisposed) return;
		this.started = true;
		this.container.classList.remove('pending');
		this.origin.container.hidden = true;
		const bounds = this.image.getBoundingClientRect();
		const samples = this.motionEnabled && bounds.width && bounds.height ? ImageSamples.create(this.image, bounds.width, bounds.height) : undefined;
		if (!samples) {
			this.effects.clear();
			return;
		}
		const surface = this.effects.add(this.origin.takeSurface?.() ?? this.instantiation.createInstance(GlyphSurface, this.container));
		const size = Math.min(this.origin.size ?? 200, this.container.parentElement?.clientWidth || bounds.width);
		const timing = surface.getRevealTiming(size);
		const duration = timing.pace.duration - (getWindow(this.container).performance.now() - loadedAt);
		if (duration <= 0) {
			this.effects.clear();
			return;
		}
		this.container.append(surface.canvas);
		this.container.classList.add('revealing');
		surface.reveal({
			image: this.image,
			samples,
			fromWidth: size,
			fromHeight: size,
			timing,
			duration,
			onFrame: frame => {
				this.container.style.width = `${frame.width}px`;
				this.container.style.height = `${frame.height}px`;
				this.image.style.opacity = String(frame.imageOpacity);
				surface.canvas.style.opacity = String(frame.textureOpacity);
			},
		});
		this.effects.add(disposableTimeout(() => this.effects.clear(), duration));
	}

	private get motionEnabled(): boolean {
		const type = this.themes.getColorTheme().colorScheme;
		return !this.accessibility.isMotionReduced() && type !== ColorScheme.HighContrastDark && type !== ColorScheme.HighContrastLight;
	}
}
