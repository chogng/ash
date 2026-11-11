import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { PromptTick } from './promptTimelineModel.js';
import type { ChatTurnChanges } from '../chatResponseFileChangesService.js';

export interface IPromptTimelineRail extends IDisposable {
	render(ticks: readonly PromptTick[], height: number): void;
	setActive(id: string | undefined): void;
}

export interface IPromptTimelineActions {
	reveal(id: string): void;
	changes?(id: string): ChatTurnChanges | undefined;
}
