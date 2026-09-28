import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorPosition, ContextView, ContextViewFocusRestore } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Menu } from '../../../../../../base/browser/ui/menu/menu.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import type { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';

interface IModePickerAction extends IAction {
	readonly actions: readonly IAction[] | (() => readonly IAction[]);
}

/** Presents the chat input's mode action as a keyboard-accessible menu. */
export class ModePickerActionItem extends ButtonActionViewItem {
	private readonly menu = this._register(new MutableDisposable<Menu>());
	private contextView: ContextView | undefined;
	private visible = false;

	constructor(
		private readonly modeAction: IModePickerAction,
		private readonly contextViewService: IContextViewService,
		private readonly onDidSelect: () => void,
	) {
		super(modeAction);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-chat-input-selector', 'ash-chat-input-mode-selector', 'ash-dropdown-menu-action-view-item');
		container.classList.toggle('disabled', !this.action.enabled);
		const button = this.button.domNode;
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName('ash-chat-input-mode-action', true);
		this.button.toggleClassName('disabled', !this.action.enabled);
		button.querySelector('.ash-button-label')?.classList.add('ash-chat-input-mode-action-label');
		button.setAttribute('aria-haspopup', 'menu');
		button.setAttribute('aria-expanded', 'false');
		const indicator = h(container.ownerDocument, 'span');
		indicator.className = 'ash-dropdown-menu-indicator ash-chat-input-mode-indicator';
		appendIcon(Lxicon.chevronDown, indicator);
		button.append(indicator);
		this.contextView = this._register(new ContextView(this.contextViewService.container));
		this._register(addDisposableListener(button, 'keydown', event => {
			if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
			stopEvent(event);
			this.show();
		}));
	}

	protected override runAction(): void {
		if (this.visible) {
			this.contextView?.hide();
			return;
		}
		this.show();
	}

	private show(): void {
		const contextView = this.contextView;
		if (!contextView || this.visible || !this.action.enabled) return;
		const actions = typeof this.modeAction.actions === 'function' ? this.modeAction.actions() : this.modeAction.actions;
		if (actions.length === 0) return;
		const menu = new Menu(contextView.element, {
			actions,
			contextViewContainer: this.contextViewService.container,
			layer: 20,
			getCheckedActionsRepresentation: () => 'radio',
			onDidSelect: () => {
				contextView.hide();
				this.onDidSelect();
			},
		});
		menu.element.classList.add('ash-chat-input-mode-menu');
		this.menu.value = menu;
		const shown = contextView.show({
			anchor: this.button.domNode,
			content: menu.element,
			anchorPosition: AnchorPosition.Below,
			gap: 2,
			presentation: 'menu',
			focusRestore: ContextViewFocusRestore.Previous,
			layer: 20,
			isTargetWithin: target => menu.contains(target),
			onHide: () => {
				this.visible = false;
				this.button.domNode.setAttribute('aria-expanded', 'false');
				this.menu.clear();
			},
		});
		if (!shown) {
			this.menu.clear();
			return;
		}
		this.visible = true;
		this.button.domNode.setAttribute('aria-expanded', 'true');
		menu.focusFirst();
	}
}
