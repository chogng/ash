import { h } from '../../../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import type { ChatContentPart } from '../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatAttachmentsContentPart } from './chatAttachmentsContentPart.js';
import { ChatInputOutputMarkdownProgressPart } from './toolInvocationParts/chatInputOutputMarkdownProgressPart.js';
import { BaseChatToolInvocationSubPart } from './toolInvocationParts/chatToolInvocationSubPart.js';

/** Owns formatted tool results and their media while either a transcript or review is visible. */
export class ChatToolOutputContentSubPart extends BaseChatToolInvocationSubPart {
	private readonly markdown: ChatInputOutputMarkdownProgressPart;
	private readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	private readonly mediaChanges = this._register(new MutableDisposable());
	private visible = true;

	constructor(document: Document, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super(h(document, 'div'));
		this.markdown = this._register(instantiation.createInstance(ChatInputOutputMarkdownProgressPart, document));
		this._register(this.markdown.onDidChangeHeight(() => this.changedHeight.fire()));
		this.domNode.append(this.markdown.domNode);
	}

	get codeblocks() { return this.markdown.codeblocks; }

	render(content: readonly ChatContentPart[], source?: IChatListItem['attachmentSource'],
		options?: { readonly generatedImages?: boolean; readonly hideFormattedResults?: boolean; },
	): void {
		this.markdown.render(options?.hideFormattedResults ? [] : content);
		const variables = options?.generatedImages ? content.map(part => part.type === 'imageUrl' || part.type === 'imageAttachment' ? { type: 'text' as const, text: '' } : part) : content;
		if (!variables.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			this.clearMedia();
			return;
		}
		if (this.media.value) {
			this.media.value.updateVariables(variables, source);
		} else {
			const media = this.media.value = this.instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: this.domNode.ownerDocument, variables, source });
			media.setVisible(this.visible);
			this.mediaChanges.value = media.onDidChangeHeight(() => this.changedHeight.fire());
			this.domNode.append(media.domNode);
		}
	}

	clearMedia(): void {
		this.mediaChanges.clear();
		this.media.clear();
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		this.markdown.setVisible(visible);
		this.media.value?.setVisible(visible);
	}
}
