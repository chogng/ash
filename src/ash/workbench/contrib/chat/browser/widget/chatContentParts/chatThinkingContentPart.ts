import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatThinkingTitleController } from '../chatThinkingTitleController.js';
import { ChatCollapsibleMarkdownContentPart } from './chatCollapsibleMarkdownContentPart.js';
import type { ChatMarkdownContentPart } from './chatMarkdownContentPart.js';
import './media/chatThinkingContent.css';

/** Owns the disclosure around a row-owned Markdown part; transcript data determines its status. */
export class ChatThinkingContentPart extends ChatCollapsibleMarkdownContentPart {
	private readonly title: ChatThinkingTitleController;

	constructor(
		document: Document,
		markdown: ChatMarkdownContentPart,
		options: { readonly expanded: boolean; readonly visible: boolean; },
	) {
		super(document, markdown, { ...options, className: 'ash-chat-thinking' });
		this.title = new ChatThinkingTitleController(this.domNode, this.summary);
	}

	public updateThinking(item: IChatListItem): void {
		this.title.update(item);
		this.markdown.tryIncrementalUpdate({ value: item.text, supportThemeIcons: true, supportAlertSyntax: true }, item.transient);
	}
}
