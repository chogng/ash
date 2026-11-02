import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';
import { h } from '../../../../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { IChatListItem } from '../../../../common/model/chatViewModel.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import { ChatResourceGroupWidget } from '../chatResourceGroupWidget.js';
import { ChatCollapsibleInputOutputContentPart } from '../chatToolInputOutputContentPart.js';

/** Owns streamed evidence and result resources. Backend coordinates remain attached to every media read. */
export class ChatToolOutputSubPart extends BaseChatToolInvocationSubPart {
	public getFileTreeInfos() { return this.resources.value?.getFileTreeInfos() ?? []; }
	public getLastFocusedFileTree() { return this.resources.value?.getLastFocusedFileTree(); }
	private readonly inputOutput: ChatCollapsibleInputOutputContentPart;
	private readonly media = this._register(new MutableDisposable<ChatAttachmentsContentPart>());
	private readonly mediaChanges = this._register(new MutableDisposable());
	private readonly resources = this._register(new MutableDisposable<ChatResourceGroupWidget>());
	private readonly resourceChanges = this._register(new MutableDisposable());
	private visible = true;

	constructor(document: Document, @IInstantiationService private readonly instantiation: IInstantiationService) {
		super(h(document, 'div'));
		this.inputOutput = this._register(new ChatCollapsibleInputOutputContentPart(document));
		this.domNode.append(this.inputOutput.domNode);
		this._register(this.inputOutput.onDidChangeHeight(() => this.changedHeight.fire()));
	}

	public render(invocation: IChatToolInvocation, source: IChatListItem['attachmentSource'], options: { readonly generatedImages: boolean; }): void {
		const { result } = invocation;
		const content = result?.content ?? [];
		this.inputOutput.render(invocation);
		const mediaContent = options.generatedImages ? content.map(part => part.type === 'imageUrl' || part.type === 'imageAttachment' ? { type: 'text' as const, text: '' } : part) : content;
		if (mediaContent.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			if (!this.media.value) {
				const media = this.instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: this.domNode.ownerDocument, variables: mediaContent, source });
				this.media.value = media;
				media.setVisible(this.visible);
				this.domNode.append(media.domNode);
				this.mediaChanges.value = media.onDidChangeHeight(() => this.changedHeight.fire());
			} else {
				this.media.value.updateVariables(mediaContent, source);
			}
		} else {
			this.mediaChanges.clear();
			this.media.clear();
		}
		if (content.some(part => part.type === 'artifact' && part.artifact.source.type !== 'mcpApp' && part.artifact.source.type !== 'viewMetadata')) {
			if (!this.resources.value) {
				const resources = this.instantiation.createInstance(ChatResourceGroupWidget, this.domNode.ownerDocument);
				this.resources.value = resources;
				this.domNode.append(resources.domNode);
				this.resourceChanges.value = resources.onDidChangeHeight(() => this.changedHeight.fire());
			}
			this.resources.value.render(content, JSON.stringify([source?.sessionId, source?.threadId, result?.itemId]), source);
		} else {
			this.resourceChanges.clear();
			this.resources.clear();
		}
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.media.value?.setVisible(visible);
	}
}
