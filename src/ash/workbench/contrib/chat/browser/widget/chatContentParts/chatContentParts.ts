import type { Event } from '../../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import type { IChatCodeBlockInfo } from '../../chat.js';

/** A content owner compares the next transcript projection with what it has rendered. */
export interface IChatContentPart extends IDisposable {
	readonly domNode: HTMLElement;
	readonly onDidChangeHeight: Event<void>;
	readonly codeblocks?: readonly IChatCodeBlockInfo[];
	readonly codeblocksPartId?: string;
	hasSameContent(other: IChatListItem): boolean;
}
