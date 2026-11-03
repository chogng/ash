import type { PromptTick } from './promptTimelineModel.js';

/** Keep every loaded prompt reachable while limiting the number of ruler marks. */
export function budgetBucketPrompts(ticks: readonly PromptTick[], budget: number): readonly (readonly PromptTick[])[] {
	const count = Math.min(ticks.length, Math.max(1, budget));
	return Array.from({ length: count }, (_, index) =>
		ticks.slice(Math.floor(index * ticks.length / count), Math.floor((index + 1) * ticks.length / count)));
}
