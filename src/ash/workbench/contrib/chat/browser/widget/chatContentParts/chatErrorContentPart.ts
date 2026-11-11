import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { ChatTurnErrorAction, IChatListItem } from '../../../common/model/chatViewModel.js';

/** Renders the literal error detail and delegates recovery to the owning conversation. */
export class ChatErrorContentPart extends Disposable {
	private readonly buttons: Button[] = [];
	private running = false;

	constructor(
		article: HTMLElement,
		item: Pick<IChatListItem, 'detail' | 'action'>,
		private readonly classPrefix: string,
		private readonly onAction: ((action: ChatTurnErrorAction) => void | Promise<void>) | undefined,
		private readonly controls = article,
	) {
		super();
		if (item.detail) {
			const detail = h(article.ownerDocument, 'p');
			detail.className = `${classPrefix}-turn-error-detail`;
			detail.textContent = item.detail;
			article.append(detail);
		}
		if (item.action) this.addAction(item.action);
	}

	protected addAction(action: ChatTurnErrorAction): void {
		if (!this.onAction) return;
		const button = this._register(new Button(this.controls, {
			...defaultButtonStyles,
			label: action.label,
			presentation: 'secondary',
			size: 'small',
			onClick: () => { void this.runAction(action).catch(() => undefined); },
		}));
		button.domNode.classList.add(`${this.classPrefix}-turn-error-action`);
		this.buttons.push(button);
	}

	private async runAction(action: ChatTurnErrorAction): Promise<void> {
		if (this.running || this.isDisposed || !this.controls.isConnected) return;
		this.running = true;
		for (const button of this.buttons) button.domNode.setAttribute('aria-disabled', 'true');
		try {
			await this.onAction?.(action);
		} finally {
			this.running = false;
			if (!this.isDisposed) {
				for (const button of this.buttons) button.domNode.removeAttribute('aria-disabled');
			}
		}
	}
}
