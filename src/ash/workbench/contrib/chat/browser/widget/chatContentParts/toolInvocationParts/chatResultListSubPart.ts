import { h } from '../../../../../../../base/browser/dom.js';
import type { AgentAttachmentSource, ChatContentPart } from '../../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../../../../nls.js';
import { ChatResourceGroupWidget } from '../chatResourceGroupWidget.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** Tool result grouping; resource reads and editor associations stay with the resource widget. */
export class ChatResultListSubPart extends BaseChatToolInvocationSubPart {
	private readonly count: HTMLElement;
	private readonly resources: ChatResourceGroupWidget;

	constructor(document: Document, @IInstantiationService instantiation: IInstantiationService) {
		super(h(document, 'section'));
		this.count = h(document, 'p');
		this.resources = this._register(instantiation.createInstance(ChatResourceGroupWidget, document));
		this._register(this.resources.onDidChangeHeight(() => this.changedHeight.fire()));
		this.domNode.append(this.count, this.resources.domNode);
	}

	public getFileTreeInfos() { return this.resources.getFileTreeInfos(); }
	public getLastFocusedFileTree() { return this.resources.getLastFocusedFileTree(); }

	public render(content: readonly ChatContentPart[], identity: string, source?: AgentAttachmentSource): void {
		const count = content.filter(part => part.type === 'artifact' && part.artifact.source.type !== 'mcpApp' && part.artifact.source.type !== 'viewMetadata').length;
		this.count.textContent = localize('chat.tool.resourceCount', '{0} result resources', count);
		this.domNode.hidden = count === 0;
		// Preserve original indices: media and view metadata can precede a resource.
		this.resources.render(content, identity, source);
	}
}
