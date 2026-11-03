import { h } from '../../../../../../../base/browser/dom.js';
import type { ActionApprovalRequest, AgentResponse, ToolConfirmationPresentation } from '../../../../../../../platform/agentHost/common/agent.js';
import { localize } from '../../../../../../../nls.js';
import { AbstractToolConfirmationSubPart } from './abstractToolConfirmationSubPart.js';

/** Proposed content is evidence for the original approval; the view never applies file changes. */
export class ChatModifiedFilesConfirmationSubPart extends AbstractToolConfirmationSubPart {
	constructor(document: Document, resolve: (response: AgentResponse) => Promise<void>, private readonly presentation: Extract<ToolConfirmationPresentation, { type: 'modifiedFiles'; }>) { super(document, resolve); }
	protected createContentElement(request: ActionApprovalRequest): HTMLElement {
		const root = h(this.domNode.ownerDocument, 'section');
		root.className = 'ash-chat-rich-tool-confirmation';
		root.append(h(root.ownerDocument, 'p', {}, request.reason));
		for (const file of this.presentation.files) {
			const details = h(root.ownerDocument, 'details');
			details.append(h(root.ownerDocument, 'summary', {}, file.path));
			for (const [text, label] of [[file.original, localize('chat.tool.originalContent', 'Original content')], [file.modified, localize('chat.tool.proposedContent', 'Proposed content')]] as const) {
				if (text === undefined || text === null) continue;
				const region = h(root.ownerDocument, 'pre');
				region.tabIndex = 0;
				region.setAttribute('role', 'region');
				region.setAttribute('aria-label', localize('chat.tool.fileEvidence', '{0}: {1}', file.path, label));
				region.textContent = text;
				details.append(h(root.ownerDocument, 'p', {}, label), region);
			}
			root.append(details);
		}
		return root;
	}
}
