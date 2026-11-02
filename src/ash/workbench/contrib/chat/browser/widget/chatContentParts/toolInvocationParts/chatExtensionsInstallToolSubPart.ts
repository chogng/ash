import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Ash extension installation remains an authorized producer operation, with no client-side install bypass. */
export class ExtensionsInstallConfirmationWidgetSubPart extends AbstractToolConfirmationSubPart {
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>, private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'extensionsInstall'; }>) { super(document, resolve); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		const root = h(this.domNode.ownerDocument, 'section');
		const list = h(root.ownerDocument, 'ul');
		list.setAttribute('aria-label', localize('chat.tool.installExtensions', 'Extensions requested for installation'));
		for (const id of this.presentation.extensions) list.append(h(root.ownerDocument, 'li', {}, id));
		root.append(h(root.ownerDocument, 'p', {}, request.reason), list);
		return root;
	}
}
