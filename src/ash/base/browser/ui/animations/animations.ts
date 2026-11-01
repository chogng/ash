import './animations.css';
import { addDisposableListener, h } from '../../dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../common/lifecycle.js';
import type { Icon } from '../../../common/icon.js';
import { appendIcon } from '../lxicons/lxicon.js';

/** Shared timing defaults for browser UI animations. */
export const UI_ANIMATION_DURATION = Object.freeze({
	fast: 120,
	normal: 200,
	slow: 350,
});

/** Standard easing used for short UI state changes. */
export const UI_ANIMATION_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

export interface UIAnimationOptions {
	readonly delay?: number;
	readonly direction?: PlaybackDirection;
	readonly duration?: number;
	readonly easing?: string;
	readonly fill?: FillMode;
	readonly iterations?: number;
	readonly respectReducedMotion?: boolean;
}

export interface BounceElementOptions {
	readonly duration?: number;
	readonly rotate?: readonly number[];
	readonly scale?: readonly number[];
	readonly translateY?: readonly number[];
}

/** Returns whether a UI animation should be suppressed for the element. */
export function isReducedMotion(element: Element): boolean {
	if (element.closest('.ash-reduce-motion')) return true;
	if (element.closest('.ash-enable-motion')) return false;
	return element.ownerDocument.defaultView?.matchMedia?.(
		'(prefers-reduced-motion: reduce)',
	)?.matches ?? false;
}

/** Starts a Web Animations API animation when the platform permits motion. */
export function animateElement(
	element: HTMLElement,
	keyframes: Keyframe[] | PropertyIndexedKeyframes,
	options: UIAnimationOptions = {},
): Animation | undefined {
	if (
		options.respectReducedMotion !== false &&
		isReducedMotion(element)
	) return undefined;
	if (typeof element.animate !== 'function') return undefined;
	return element.animate(keyframes, {
		delay: options.delay ?? 0,
		direction: options.direction ?? 'normal',
		duration: options.duration ?? UI_ANIMATION_DURATION.normal,
		easing: options.easing ?? UI_ANIMATION_EASING,
		fill: options.fill ?? 'both',
		iterations: options.iterations ?? 1,
	});
}

/** Builds the same compact bounce primitive used by VS Code's UI animations. */
export function bounceElement(
	element: HTMLElement,
	options: BounceElementOptions,
): Animation | undefined {
	const steps = Math.max(
		options.scale?.length ?? 0,
		options.rotate?.length ?? 0,
		options.translateY?.length ?? 0,
	);
	if (steps === 0) return undefined;

	const keyframes: Keyframe[] = [];
	for (let index = 0; index < steps; index += 1) {
		const transforms: string[] = [];
		const scale = options.scale?.[index];
		const rotate = options.rotate?.[index];
		const translateY = options.translateY?.[index];
		if (scale !== undefined) transforms.push(`scale(${scale})`);
		if (rotate !== undefined) transforms.push(`rotate(${rotate}deg)`);
		if (translateY !== undefined) transforms.push(`translateY(${translateY}px)`);
		keyframes.push({
			offset: steps === 1 ? 1 : index / (steps - 1),
			...(transforms.length > 0 ? { transform: transforms.join(' ') } : {}),
		});
	}

	return animateElement(element, keyframes, {
		duration: options.duration ?? UI_ANIMATION_DURATION.normal,
		easing: UI_ANIMATION_EASING,
		fill: 'forwards',
	});
}
export interface IAnimationTarget {
	readonly element: HTMLElement;
	readonly rect: DOMRectReadOnly;
	readonly container: HTMLElement;
}

export enum ClickAnimation {
	Confetti = 1,
	FloatingIcons = 2,
	PulseWave = 3,
	RadiantLines = 4,
}

/** Capture before running an action: its source may disappear when the action succeeds. */
export function captureAnimationTarget(element: HTMLElement): IAnimationTarget {
	return {
		element,
		rect: element.getBoundingClientRect(),
		container: element.closest<HTMLElement>('[data-color-theme]') ?? element.ownerDocument.body,
	};
}

/** One bounded, decorative burst. The caller may cancel it; completion releases it automatically. */
function playClickAnimation(target: HTMLElement | IAnimationTarget, render: (overlay: HTMLElement, animations: Animation[]) => void): IDisposable | undefined {
	const captured = 'rect' in target ? target : captureAnimationTarget(target);
	const { element, rect, container } = captured;
	if (!container.isConnected || isReducedMotion(container) || typeof element.animate !== 'function') return undefined;
	const resources = new DisposableStore();
	const overlay = h(container.ownerDocument, 'div', { className: 'ash-click-animation' });
	overlay.setAttribute('aria-hidden', 'true');
	Object.assign(overlay.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
	const animations: Animation[] = [];
	resources.add(toDisposable(() => {
		for (const animation of animations) animation.cancel();
		overlay.remove();
	}));
	const ownerWindow = container.ownerDocument.defaultView!;
	resources.add(addDisposableListener(ownerWindow, 'pagehide', () => resources.dispose(), { once: true }));
	container.append(overlay);
	render(overlay, animations);
	if (element.isConnected) {
		const bounce = bounceElement(element, { scale: [1, 1.06, 1], duration: UI_ANIMATION_DURATION.normal });
		if (bounce) animations.push(bounce);
	}
	void Promise.allSettled(animations.map(animation => animation.finished)).then(() => resources.dispose());
	return resources;
}

/** A finite burst; all click effects share the same reduced-motion and disposal boundary. */
export function triggerConfettiAnimation(target: HTMLElement | IAnimationTarget): IDisposable | undefined {
	return playClickAnimation(target, (overlay, animations) => {
		overlay.classList.add('ash-click-confetti');
		// Prepare a small set of keyframes once; the browser owns interpolation and playback.
		for (let index = 0; index < 18; index++) {
			const particle = h(overlay.ownerDocument, 'span', { className: 'ash-click-confetti-particle' });
			overlay.append(particle);
			const angle = (index * 137.5) * Math.PI / 180;
			const x = Math.cos(angle) * (28 + index % 4 * 12);
			const apex = -36 - index % 5 * 10;
			const rotation = index % 2 === 0 ? 180 : -180;
			const animation = animateElement(particle, [
				{ transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
				{ opacity: 1, offset: 0.12 },
				{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${apex}px)) rotate(${rotation / 2}deg)`, opacity: 1, offset: 0.4 },
				{ transform: `translate(calc(-50% + ${x * 1.4}px), calc(-50% + ${32 + index % 4 * 12}px)) rotate(${rotation}deg)`, opacity: 0 },
			], { duration: 850 + index % 3 * 60, easing: 'linear', fill: 'none' });
			if (animation) animations.push(animation);
		}
	});
}

/** Explicit feedback for a successful action; ordinary state transitions remain owned by CSS. */
export function triggerClickAnimation(target: HTMLElement | IAnimationTarget, kind: ClickAnimation, icon?: Icon): IDisposable | undefined {
	if (kind === ClickAnimation.Confetti) return triggerConfettiAnimation(target);
	if (kind === ClickAnimation.FloatingIcons && !icon) return undefined;
	return playClickAnimation(target, (overlay, animations) => {
		const count = kind === ClickAnimation.FloatingIcons ? 6 : kind === ClickAnimation.PulseWave ? 3 : 8;
		for (let index = 0; index < count; index++) {
			const element = h(overlay.ownerDocument, 'span');
			overlay.append(element);
			let keyframes: Keyframe[];
			if (kind === ClickAnimation.FloatingIcons) {
				element.className = 'ash-click-feedback-icon';
				appendIcon(icon!, element);
				const x = (index - 2.5) * 10;
				keyframes = [{ transform: 'translate(-50%, -50%) scale(0.5)', opacity: 0 },
				{ opacity: 1, offset: 0.2 }, { transform: `translate(calc(-50% + ${x}px), -70px) scale(1)`, opacity: 0 }];
			} else if (kind === ClickAnimation.PulseWave) {
				element.className = 'ash-click-feedback-ring';
				keyframes = [{ transform: 'scale(0.6)', opacity: 0 }, { opacity: 0.8, offset: 0.15 }, { transform: 'scale(2.6)', opacity: 0 }];
			} else {
				element.className = 'ash-click-feedback-ray';
				const rotation = index * 45;
				keyframes = [{ transform: `translate(-50%, -50%) rotate(${rotation}deg) translateY(-8px) scaleY(0)`, opacity: 0 },
				{ opacity: 1, offset: 0.15 }, { transform: `translate(-50%, -50%) rotate(${rotation}deg) translateY(-30px) scaleY(0.3)`, opacity: 0 }];
			}
			const animation = animateElement(element, keyframes, { duration: 700, delay: index * 40, fill: 'none' });
			if (animation) animations.push(animation);
		}
	});
}
