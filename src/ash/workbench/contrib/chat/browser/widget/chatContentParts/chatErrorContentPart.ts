import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../../common/model/chatViewModel.js';

/** Renders the literal error detail and delegates recovery to the owning conversation. */
export class ChatErrorContentPart extends Disposable {
	constructor(
		article: HTMLElement,
		item: Pick<IChatListItem, 'detail' | 'action'>,
		classPrefix: string,
		onAction: ((action: ChatTurnErrorAction) => void) | undefined,
	) {
		super();
		if (item.detail) {
			const detail = h(article.ownerDocument, 'p');
			detail.className = `${classPrefix}-turn-error-detail`;
			detail.textContent = item.detail;
			article.append(detail);
		}
		const action = item.action;
		if (action) {
			const button = this._register(new Button(article, {
				...defaultButtonStyles,
				label: action.label,
				presentation: 'secondary',
				size: 'small',
				onClick: () => onAction?.(action),
			}));
			button.domNode.classList.add(`${classPrefix}-turn-error-action`);
		}
	}
}
