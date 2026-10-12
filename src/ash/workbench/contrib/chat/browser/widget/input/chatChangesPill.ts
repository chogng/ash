import './media/chatChangesPill.css';
import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import type { TurnChangeSetSummary } from '../../../../../services/chat/common/chatService.js';

/** Presents the conversation owner's statistics without retaining another copy. */
export class ChatChangesPill extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly button: Button;
	private readonly additions: HTMLSpanElement;
	private readonly deletions: HTMLSpanElement;

	constructor(container: HTMLElement, openChanges: () => void, private readonly focusInput: () => void) {
		super();
		this.domNode = h(container.ownerDocument, 'div', { className: 'ash-chat-input-changes' });
		this.domNode.hidden = true;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.button = this._register(new Button(this.domNode, {
			label: '', icon: Lxicon.diff, onClick: openChanges,
		}));
		this.button.domNode.classList.add('ash-chat-changes-pill');
		this.additions = h(container.ownerDocument, 'span', { className: 'ash-chat-changes-added' });
		this.deletions = h(container.ownerDocument, 'span', { className: 'ash-chat-changes-removed' });
		this.additions.setAttribute('aria-hidden', 'true');
		this.deletions.setAttribute('aria-hidden', 'true');
		this.button.domNode.append(this.additions, this.deletions);
	}

	render(statistics: TurnChangeSetSummary['statistics'] | undefined, enabled: boolean): void {
		const visible = statistics !== undefined && statistics.files > 0 && enabled;
		if (!visible && this.domNode.contains(this.domNode.ownerDocument.activeElement)) {
			this.focusInput();
		}
		this.domNode.hidden = !visible;
		if (!statistics) return;
		this.button.label = statistics.files === 1
			? localize('chat.changes.file', '{0} file', statistics.files)
			: localize('chat.changes.files', '{0} files', statistics.files);
		const label = localize('chat.changes.open', 'Open Changes: {0} files, {1} lines added, {2} lines removed', statistics.files, statistics.additions, statistics.deletions);
		if (this.button.domNode.getAttribute('aria-label') !== label) {
			this.button.domNode.setAttribute('aria-label', label);
			this.button.setTitle(label);
		}
		this.additions.textContent = `+${statistics.additions}`;
		this.deletions.textContent = `−${statistics.deletions}`;
	}
}
