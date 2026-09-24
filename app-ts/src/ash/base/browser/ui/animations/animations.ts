/** Shared timing defaults for browser UI animations. */
export const UI_ANIMATION_DURATION = Object.freeze({
	fast: 120,
	normal: 200,
	slow: 350,
});

/** Standard easing used for short UI state changes. */
export const UI_ANIMATION_EASING = "cubic-bezier(0.4, 0, 0.2, 1)";

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
	if (element.closest(".ash-reduce-motion")) return true;
	return element.ownerDocument.defaultView?.matchMedia?.(
		"(prefers-reduced-motion: reduce)",
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
	if (typeof element.animate !== "function") return undefined;
	return element.animate(keyframes, {
		delay: options.delay ?? 0,
		direction: options.direction ?? "normal",
		duration: options.duration ?? UI_ANIMATION_DURATION.normal,
		easing: options.easing ?? UI_ANIMATION_EASING,
		fill: options.fill ?? "both",
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
			...(transforms.length > 0 ? { transform: transforms.join(" ") } : {}),
		});
	}

	return animateElement(element, keyframes, {
		duration: options.duration ?? UI_ANIMATION_DURATION.normal,
		easing: UI_ANIMATION_EASING,
		fill: "forwards",
	});
}
