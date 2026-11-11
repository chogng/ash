import { h } from '../../../../../base/browser/dom.js';
import { ActionViewItem, type ActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { AnchorPosition, ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
import type { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { formatLoadedSkillReason } from '../../common/model/chatViewModel.js';
import { ChatResponseActionContext } from '../chat.js';

/** Displays the count as part of the existing reply action bar. */
export class ChatLoadedSkillsActionViewItem extends ActionViewItem {
	private button: Button | undefined;
	private readonly popup = this._register(new MutableDisposable());

	constructor(action: IAction, options: ActionViewItemOptions, private readonly count: number) {
		super(action, options);
	}

	override render(container: HTMLElement): void {
		const count = new Intl.NumberFormat(getNLSLanguage()).format(this.count);
		const label = localize('chat.skills.viewLoadedCount', 'View loaded Skills ({0})', count);
		const button = this.button = this.createButton(container, {
			label: count, title: label, ariaLabel: label, icon: Lxicon.skill, iconOnly: false,
			onClick: () => this.runActionWithContext(this.action, this),
		});
		button.domNode.setAttribute('aria-haspopup', 'dialog');
		button.domNode.setAttribute('aria-expanded', 'false');
	}

	override focus(): void { this.button?.focus(); }
	override setTabbable(tabbable: boolean): void {
		if (this.button) this.button.domNode.tabIndex = tabbable ? 0 : -1;
	}

	/** Opens details scoped to the exact reply and its toolbar lifetime. */
	show(contextView: IContextViewService): void {
		const response = this.actionContext;
		const anchor = this.button?.domNode;
		if (!(response instanceof ChatResponseActionContext) || !response.visible || !anchor?.isConnected) return;
		const skills = response.item.loadedSkills;
		if (!skills?.length) return;
		if (this.popup.value) {
			this.popup.clear();
			return;
		}
		const document = anchor.ownerDocument;
		const title = localize('chat.skills.loadedTitle', 'Skills loaded in this turn');
		const content = h(document, 'div', {
			className: 'ash-chat-loaded-skills',
			attributes: { role: 'dialog', 'aria-label': title, tabindex: '-1' },
		});
		const heading = h(document, 'h2');
		heading.textContent = title;
		const list = h(document, 'ul');
		const seen = new Set<string>();
		const duplicates = new Set<string>();
		for (const { name } of skills) {
			if (seen.has(name)) duplicates.add(name);
			seen.add(name);
		}
		for (const skill of skills) {
			const item = h(document, 'li');
			const reason = formatLoadedSkillReason(skill.reason);
			item.textContent = duplicates.has(skill.name)
				? localize('chat.skills.loadedDetailWithSource', '{0} · {1} · {2}', skill.name, reason, skill.source)
				: localize('chat.skills.loadedDetail', '{0} · {1}', skill.name, reason);
			list.append(item);
		}
		content.append(heading, list);
		if (contextView.show({
			anchor, content, anchorPosition: AnchorPosition.Below, presentation: 'hover',
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: () => {
				anchor.setAttribute('aria-expanded', 'false');
				this.popup.clear();
			},
		})) {
			anchor.setAttribute('aria-expanded', 'true');
			this.popup.value = toDisposable(() => {
				if (anchor.getAttribute('aria-expanded') === 'true') contextView.hide();
			});
			content.focus();
		}
	}
}
