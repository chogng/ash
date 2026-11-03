import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IChatListItem } from '../../common/model/chatViewModel.js';
import type { PromptFileDiff, PromptTick } from './promptTimelineModel.js';

export interface IPromptTimelineRail extends IDisposable {
	render(ticks: readonly PromptTick[], height: number): void;
	setActive(id: string | undefined): void;
}

export interface IPromptTimelineActions {
	reveal(prompt: IChatListItem): void;
	files(prompt: IChatListItem): readonly PromptFileDiff[];
}
