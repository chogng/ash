/** One bloom followed by a quiet hold, shared by live font playback and raster sampling. */
export const chatWorkingLogoDrawDuration = 2400;

export interface IChatWorkingLogoDrawArtwork {
	readonly font: string;
	readonly fontSize: number;
	readonly width: number;
	readonly height: number;
	readonly layers: readonly {
		readonly character: string;
		readonly origin: string;
		readonly keyframes: Keyframe[];
	}[];
}

/** Extend the existing titlebar bloom's CSS animations into a synchronized working loop. */
export function startChatWorkingLogoDraw(mark: HTMLElement): Animation[] {
	const animations = mark.getAnimations({ subtree: true });
	for (const animation of animations) {
		const effect = animation.effect as KeyframeEffect;
		const layer = effect.target as HTMLElement;
		const style = layer.ownerDocument.defaultView!.getComputedStyle(layer);
		const timing = effect.getTiming();
		if (typeof timing.duration !== 'number') continue;
		const keyframes = effect.getKeyframes().map(({ computedOffset, ...frame }) => {
			// Resolve the titlebar's petal variables once, while preserving font-relative geometry.
			for (const [property, value] of Object.entries(frame)) {
				if (typeof value !== 'string') continue;
				frame[property] = value.replace(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g,
					(_, name: string, fallback: string | undefined) => style.getPropertyValue(name).trim() || fallback || '0');
			}
			return { ...frame, offset: ((timing.delay ?? 0) + computedOffset * Number(timing.duration)) / chatWorkingLogoDrawDuration };
		});
		if (!keyframes.length) continue;
		keyframes.unshift({ ...keyframes[0], offset: 0 });
		keyframes.push({ ...keyframes.at(-1)!, offset: 1 });
		effect.setKeyframes(keyframes);
		effect.updateTiming({ delay: 0, duration: chatWorkingLogoDrawDuration, iterations: Infinity, fill: 'both', easing: 'linear' });
		animation.currentTime = 0;
		animation.play();
	}
	return animations;
}

/** Capture resolved font glyphs and effects, without keeping a consumer's DOM in the shared cache. */
export function captureChatWorkingLogoDraw(mark: HTMLElement, animations: readonly Animation[]): IChatWorkingLogoDrawArtwork {
	const style = mark.ownerDocument.defaultView!.getComputedStyle(mark);
	return {
		font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
		fontSize: parseFloat(style.fontSize),
		width: parseFloat(style.width), height: parseFloat(style.height),
		layers: animations.map(animation => {
			const effect = animation.effect as KeyframeEffect;
			const layer = effect.target as HTMLElement;
			return {
				character: layer.dataset.ashIconCharacter!,
				origin: layer.style.transformOrigin,
				keyframes: effect.getKeyframes(),
			};
		}),
	};
}
