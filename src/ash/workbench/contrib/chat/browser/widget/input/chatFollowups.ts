import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from './chatInputStack.js';

/** Presents the latest reply's suggestions as input actions scoped to the current conversation. */
export class ChatFollowups extends Disposable {
	readonly domNode: HTMLElement;
	private readonly buttons = this._register(new DisposableStore());
	private identity: string | undefined;

	constructor(document: Document, accept: (prompt: string) => void) {
		super();
		this.domNode = h(document, 'div', {
			className: `ash-chat-followups ${chatInputStackSlotClass}`,
			attributes: { role: 'group', 'aria-label': localize('chat.followups.suggested', 'Suggested follow-ups') },
		});
		this.domNode.hidden = true;
		this.accept = accept;
	}

	private readonly accept: (prompt: string) => void;

	render(scope: string | undefined, prompts: readonly string[]): void {
		const identity = scope && prompts.length ? JSON.stringify([scope, prompts]) : undefined;
		if (identity === this.identity) return;
		this.identity = identity;
		this.buttons.clear();
		this.domNode.hidden = !identity;
		setChatInputStackSlot(this.domNode, identity ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
		if (!identity) return;
		for (const prompt of prompts) {
			this.buttons.add(new Button(this.domNode, {
				...defaultButtonStyles,
				label: prompt,
				presentation: 'secondary',
				size: 'small',
				onClick: () => {
					if (identity === this.identity && this.domNode.isConnected) this.accept(prompt);
				},
			}));
		}
	}
}
