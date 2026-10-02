import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Separator, type IAction } from '../../../../../../base/common/actions.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { ActionListItemKind } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { ChatMode } from '../../../../../services/chat/common/chatService.js';

interface IModePickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => Promise<readonly IAction[]>);
}

export type ChatInputMode = ChatMode;

/** Presents the chat input's mode action as a keyboard-accessible menu. */
export class ModePickerActionItem extends ButtonActionViewItem {
	private visible = false;
	private opening = false;

	constructor(
		private readonly modeAction: IModePickerAction,
		private readonly mode: ChatInputMode,
		private readonly onDidSelect: () => void,
		@IActionWidgetService private readonly actionWidgetService: IActionWidgetService,
	) {
		super(modeAction);
		this._register(toDisposable(() => {
			if (this.visible) this.actionWidgetService.hide();
		}));
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-mode-selector', 'ash-dropdown-menu-action-view-item', `mode-${this.mode}`);
		container.classList.toggle('disabled', !this.action.enabled);
		const button = this.button.domNode;
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-mode-action', true);
		this.button.toggleClassName('disabled', !this.action.enabled);
		button.querySelector('.ash-button-label')?.classList.add('ash-chat-input-mode-action-label');
		button.setAttribute('aria-label', this.action.tooltip);
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		const indicator = h(container.ownerDocument, 'span');
		indicator.className = 'ash-dropdown-menu-indicator ash-chat-input-mode-indicator';
		appendIcon(Lxicon.chevronDown, indicator);
		button.append(indicator);
		this._register(addDisposableListener(button, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			stopEvent(event);
			void this.show();
		}));
	}

	protected override runAction(): void {
		if (this.visible) {
			this.actionWidgetService.hide();
			return;
		}
		void this.show();
	}

	private async show(): Promise<void> {
		if (this.visible || this.opening || !this.action.enabled) return;
		this.opening = true;
		let actions: readonly IAction[];
		try {
			actions = typeof this.modeAction.actions === 'function' ? await this.modeAction.actions() : this.modeAction.actions;
		} catch {
			return;
		} finally {
			this.opening = false;
		}
		if (this.isDisposed) return;
		if (actions.length === 0) return;
		this.visible = true;
		this.button.domNode.setAttribute('aria-expanded', 'true');
		this.actionWidgetService.show('chatModePicker', false, actions.map(action => ({
			kind: action instanceof Separator ? ActionListItemKind.Separator : ActionListItemKind.Action,
			item: action,
			label: action.label,
			disabled: !action.enabled,
			checked: action.checked,
			group: { title: '', icon: action.icon },
		})), {
			onSelect: async action => {
				// Switching a mode can replace this toolbar item, so release its popup first.
				this.actionWidgetService.hide(false);
				await action.run();
				this.onDidSelect();
			},
			onHide: () => {
				this.visible = false;
				this.button.domNode.setAttribute('aria-expanded', 'false');
			},
		}, this.button.domNode, { className: 'ash-chat-input-mode-menu' });
	}
}
