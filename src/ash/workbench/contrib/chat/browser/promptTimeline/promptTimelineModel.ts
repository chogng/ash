import type { IChangesStats } from '../../../../browser/changesStatsWidget.js';

interface PromptFileDiff {
	readonly id: string;
	readonly path: string;
	readonly review: () => void;
}

export interface PromptTurnChanges extends IChangesStats {
	readonly fileDiffs: readonly PromptFileDiff[];
	review(): void | Promise<void>;
}

export interface PromptTimelinePrompt {
	readonly id: string;
	readonly text: string;
}

export interface PromptTick {
	readonly prompt: PromptTimelinePrompt;
	readonly position: number;
}

/** Derives navigation from the same rendered rows the transcript uses for reveal. */
export class PromptTimelineModel<T extends PromptTimelinePrompt = PromptTimelinePrompt> {
	constructor(
		readonly prompts: readonly T[],
		private readonly getRow: (id: string) => HTMLElement,
	) { }

	firstPromptAfter(top: number): number {
		let low = 0;
		let high = this.prompts.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.bounds(this.prompts[middle]).top <= top) low = middle + 1;
			else high = middle;
		}
		return low;
	}

	bounds(prompt: PromptTimelinePrompt): DOMRect {
		return this.getRow(prompt.id).getBoundingClientRect();
	}

	ticks(viewport: HTMLElement): PromptTick[] {
		const origin = viewport.getBoundingClientRect().top - viewport.scrollTop;
		return this.prompts.map(prompt => ({
			prompt,
			position: Math.min(1, Math.max(0, (this.bounds(prompt).top - origin) / Math.max(1, viewport.scrollHeight))),
		}));
	}
}
