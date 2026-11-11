import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ChatExtensionsContentPart } from '../chatExtensionsContentPart.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Ash extension installation remains an authorized producer operation, with no client-side install bypass. */
export class ExtensionsInstallConfirmationWidgetSubPart extends AbstractToolConfirmationSubPart {
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>,
		private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'extensionsInstall'; }>,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) { super(document, resolve); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		const root = h(this.domNode.ownerDocument, 'section');
		const list = this.content.add(this.instantiation.createInstance(ChatExtensionsContentPart, root.ownerDocument, this.presentation.extensions));
		root.append(h(root.ownerDocument, 'p', {}, request.reason), list.domNode);
		return root;
	}
}
