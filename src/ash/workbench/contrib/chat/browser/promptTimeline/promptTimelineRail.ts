import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { PromptTurnChanges, PromptTick } from './promptTimelineModel.js';

export interface IPromptTimelineRail extends IDisposable {
	render(ticks: readonly PromptTick[], height: number): void;
	setActive(id: string | undefined): void;
}

export interface IPromptTimelineActions {
	reveal(id: string): void;
	changes?(id: string): PromptTurnChanges | undefined;
}
