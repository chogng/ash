export interface PromptTimelinePrompt {
	readonly id: string;
	readonly text: string;
}

export interface PromptTick {
	readonly prompt: PromptTimelinePrompt;
	readonly position: number;
}

/** Derives navigation from transcript positions, including rows outside the render window. */
export class PromptTimelineModel<T extends PromptTimelinePrompt = PromptTimelinePrompt> {
	constructor(
		readonly prompts: readonly T[],
		private readonly getTop: (id: string) => number,
	) { }

	firstPromptAfter(top: number): number {
		let low = 0;
		let high = this.prompts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.top(this.prompts[middle]) <= top) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	top(prompt: PromptTimelinePrompt): number {
		return this.getTop(prompt.id);
	}

	ticks(viewport: HTMLElement): PromptTick[] {
		const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
		return this.prompts.map(prompt => ({
			prompt,
			position: Math.min(1, Math.max(0, (this.top(prompt) - origin) / Math.max(1, viewport.scrollHeight))),
		}));
	}
}
