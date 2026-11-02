import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import type { AgentResponse, ToolResultReviewRequest } from '../../../../../../../platform/agentHost/common/agent.js';
import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import { ChatAttachmentsContentPart } from '../chatAttachmentsContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

/** Reviews disclosure of a captured result. Reply authority stays with the input's exact offer. */
export class ChatToolPostExecuteConfirmationPart extends BaseChatToolInvocationSubPart {
	constructor(
		document: Document,
		request: ToolResultReviewRequest,
		resolve: (response: AgentResponse) => Promise<void>,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(h(document, 'section'));
		this.domNode.className = 'ash-chat-tool-result-review';
		this.domNode.setAttribute('aria-label', localize('chat.resultReview.title', 'Review {0} results', request.toolName));
		const reason = h(document, 'p');
		reason.textContent = request.review.reason;
		const explanation = h(document, 'p');
		explanation.textContent = localize('chat.resultReview.explanation', 'The tool has executed. Sharing sends these results to the model. Skipping keeps the execution record and does not undo changes.');
		const preview = h(document, 'pre');
		preview.tabIndex = 0;
		preview.setAttribute('role', 'region');
		preview.setAttribute('aria-label', localize('chat.resultReview.preview', 'Results awaiting review'));
		preview.textContent = request.review.content.flatMap(part => {
			if (part.type === 'text') { return [part.text]; }
			if (part.type !== 'artifact' || part.artifact.source.type === 'viewMetadata' || part.artifact.source.type === 'mcpApp') { return []; }
			const data = part.artifact.data;
			return data.type === 'text' ? [data.text] : data.type === 'json' ? [data.json] : [localize('chat.resultReview.binary', 'Binary result ({0})', part.artifact.mimeType)];
		}).join('\n\n');
		preview.hidden = !preview.textContent;
		this.domNode.append(reason, explanation, preview);
		if (request.review.content.some(part => part.type !== 'text' && part.type !== 'artifact')) {
			const media = this._register(instantiation.createInstance(ChatAttachmentsContentPart, { ownerDocument: document, variables: request.review.content }));
			this._register(media.onDidChangeHeight(() => this.changedHeight.fire()));
			this.domNode.append(media.domNode);
		}
		const actions = h(document, 'div');
		actions.className = 'ash-chat-interaction-actions';
		for (const decision of ['skip', 'share'] as const) {
			this._register(new Button(actions, {
				...defaultButtonStyles,
				label: decision === 'share' ? localize('chat.resultReview.share', 'Share results') : localize('chat.resultReview.skip', 'Skip results'),
				presentation: decision === 'share' ? 'primary' : 'secondary',
				onClick: () => { void resolve({ type: 'toolResultReview', response: { decision } }).catch(() => undefined); },
			}));
		}
		this.domNode.append(actions);
	}
}
