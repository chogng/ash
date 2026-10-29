import './media/animatedCounterWidget.css';
import { h } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../base/common/observable.js';
import { IAccessibilityService } from '../../platform/accessibility/common/accessibility.js';

export interface IAnimatedCounterWidgetOptions {
	readonly prefix?: string;
	readonly cssClassName?: string;
	/** Direction for increasing counts; decreasing counts travel the opposite way. */
	readonly direction?: 'topToBottom' | 'bottomToTop';
	readonly duration?: number;
	readonly count: IObservable<number | undefined>;
}

/** Displays the latest count immediately while animating its visual transition. */
export class AnimatedCounterWidget extends Disposable {
	private readonly element: HTMLSpanElement;
	private readonly value: HTMLSpanElement;
	private count: number | undefined;
	private outgoing: HTMLSpanElement | undefined;
	private animations: Animation[] = [];

	constructor(
		container: HTMLElement,
		private readonly options: IAnimatedCounterWidgetOptions,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
	) {
		super();
		this.element = h(container.ownerDocument, 'span', { className: 'ash-animated-counter' });
		if (options.cssClassName) this.element.classList.add(options.cssClassName);
		this.value = h(container.ownerDocument, 'span', { className: 'ash-animated-counter-value' });
		this.element.append(this.value);
		container.append(this.element);
		this._register(
			toDisposable(() => {
				this.stopAnimation();
				this.element.remove();
			}),
		);
		this._register(
			accessibilityService.onDidChangeReducedMotion(() => {
				if (accessibilityService.isMotionReduced()) this.stopAnimation();
			}),
		);
		this._register(autorun(reader => this.update(options.count.read(reader))));
	}

	private update(count: number | undefined): void {
		if (count === this.count) return;
		const previousCount = this.count;
		const previousText = this.value.textContent ?? '';
		const animate =
			previousCount !== undefined &&
			count !== undefined &&
			this.options.duration !== 0 &&
			!this.accessibilityService.isMotionReduced() &&
			typeof this.element.animate === 'function' &&
			this.element.getClientRects().length > 0;
		const previousWidth = animate ? this.element.getBoundingClientRect().width : 0;
		// Interrupt older transitions instead of queuing stale counts behind them.
		this.stopAnimation();
		this.count = count;
		this.value.textContent = count === undefined ? '' : `${this.options.prefix ?? ''}${count}`;
		if (!animate) return;

		const nextWidth = this.element.getBoundingClientRect().width;
		const outgoing = h(this.element.ownerDocument, 'span', { className: 'ash-animated-counter-outgoing' });
		outgoing.setAttribute('aria-hidden', 'true');
		// Generated content keeps the departing value out of text snapshots and Accessible View.
		outgoing.dataset.value = previousText;
		this.element.append(outgoing);
		this.outgoing = outgoing;
		const down = count! > previousCount! === (this.options.direction !== 'bottomToTop');
		const offset = down ? '-100%' : '100%';
		const timing: KeyframeAnimationOptions = { duration: this.options.duration ?? 240, easing: 'ease-out' };
		this.animations.push(
			this.value.animate(
				[
					{ transform: `translateY(${offset})`, opacity: 0 },
					{ transform: 'translateY(0)', opacity: 1 },
				],
				timing,
			),
		);
		const departure = outgoing.animate(
			[
				{ transform: 'translateY(0)', opacity: 1 },
				{ transform: `translateY(${down ? '100%' : '-100%'})`, opacity: 0 },
			],
			timing,
		);
		this.animations.push(departure);
		if (Math.abs(previousWidth - nextWidth) > 0.5) {
			this.animations.push(this.element.animate([{ width: `${previousWidth}px` }, { width: `${nextWidth}px` }], timing));
		}
		departure.onfinish = departure.oncancel = () => this.stopAnimation();
	}

	private stopAnimation(): void {
		for (const animation of this.animations) {
			animation.onfinish = animation.oncancel = null;
			animation.cancel();
		}
		this.animations = [];
		this.outgoing?.remove();
		this.outgoing = undefined;
	}
}
