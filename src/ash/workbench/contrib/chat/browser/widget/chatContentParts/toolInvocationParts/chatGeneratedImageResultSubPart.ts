import { h } from '../../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import type { ChatContentPart } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatImageRevealOrigin } from '../../../attachments/chatImageReveal.js';
import type { IChatListItem } from '../../chatListItems.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import '../media/chatImageGenerationProgressPart.css';

/** Selects the image result gallery while the shared media owner retains reads, previews and URLs. */
export class ChatGeneratedImageResultSubPart extends Disposable {
	readonly domNode: HTMLElement;
	private readonly media: ChatAttachmentsContentPart;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this.changed.event;

	constructor(document: Document, content: readonly ChatContentPart[], source: IChatListItem['attachmentSource'], imageReveal: IChatImageRevealOrigin | undefined,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-chat-generated-image-result';
		this.media = this._register(instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: document, variables: [], source, imagePresentation: 'inline', imageReveal }));
		this.domNode.append(this.media.domNode);
		this._register(this.media.onDidChangeHeight(() => this.changed.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
		this.render(content, source);
	}

	render(content: readonly ChatContentPart[], source: IChatListItem['attachmentSource']): void {
		const images = content.filter(part => part.type === 'imageUrl' || part.type === 'imageAttachment');
		this.domNode.setAttribute('aria-label', localize('chat.imageGeneration.results', 'Generated images ({0})', images.length));
		// Preserve tool-result content indices: filtering would read the wrong persisted attachment.
		this.media.updateVariables(content.map(part => part.type === 'imageUrl' || part.type === 'imageAttachment' ? part : { type: 'text', text: '' }), source);
	}

	setVisible(visible: boolean): void { this.media.setVisible(visible); }
}
