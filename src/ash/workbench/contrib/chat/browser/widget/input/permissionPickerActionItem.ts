import { addDisposableListener, stopEvent } from '../../../../../../base/browser/dom.js';
import { KeybindingLabel } from '../../../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../base/common/event.js';
import { Keybinding, logicalKey, resolveKeybinding } from '../../../../../../base/common/keybindings.js';
import { DisposableStore, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultKeybindingLabelStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ChatInputPickerActionViewItem } from './chatInputPickerActionItem.js';

/** Shared permission presentation; the composer owns the selected mode and confirmation policy. */
export class PermissionPickerActionItem extends ChatInputPickerActionViewItem {
	constructor(
		action: IAction,
		private readonly onDidChange: Event<void>,
		actionProvider: IActionWidgetDropdownActionProvider,
		@IActionWidgetService private readonly actionWidget: IActionWidgetService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@INotificationService notifications: INotificationService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		const title = localize('chat.input.permissions', 'Permissions');
		super(action, {
			actionProvider,
			listOptions: {
				presentation: 'details', className: 'ash-chat-permission-menu ash-action-widget-accent-checks',
				showRowTooltips: false,
				ariaLabel: title, minWidth: 370, maxWidth: 370,
				accessibilityHelp: () => accessibleViews.show(AccessibleViewType.Help),
			},
			tabLeavesPopup: true,
			focusItemOnPointerOpen: false,
			onShow: menu => this.decorateMenu(menu),
			onError: error => notifications.error(error instanceof Error ? error : String(error)),
		}, instantiationService);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.element.classList.add('ash-chat-input-permission-picker');
		this._register(this.onDidChange(() => {
			this.refreshActionLabel();
			this.updateEnabled();
			this.setTabbable(true);
		}));
		this.setTabbable(true);
	}

	public override show(anchor?: HTMLElement): void {
		if (this.action.enabled && this.element.getAttribute('aria-expanded') !== 'true') {
			this.focus();
		}
		super.show(anchor);
	}

	private decorateMenu(menu: HTMLElement): IDisposable {
		const popup = new DisposableStore();
		const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
		for (const [index, button] of buttons.entries()) {
			const key = String(index + 1);
			button.setAttribute('aria-keyshortcuts', key);
			const shortcut = popup.add(new KeybindingLabel(button, {
				...defaultKeybindingLabelStyles,
				keybinding: resolveKeybinding(Keybinding.single(logicalKey(key))),
				presentation: 'keycap',
			}));
			shortcut.element.setAttribute('aria-hidden', 'true');
		}
		popup.add(addDisposableListener(menu, 'keydown', event => {
			if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) { return; }
			if (/^[123]$/u.test(event.key)) {
				stopEvent(event);
				buttons[Number(event.key) - 1]?.click();
			}
		}, true));
		popup.add(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 110, name: 'chat-permissions',
			getProvider: () => menu.contains(menu.ownerDocument.activeElement) ? new AccessibleContentProvider(
				AccessibleViewProviderId.ActionWidget, { type: AccessibleViewType.Help },
				() => localize('chat.input.permissionsHelp', 'Permissions menu\nUse Up and Down Arrow, Home and End to choose a permission mode. Press Enter or Space to select it. While this menu is open, press 1, 2, or 3 to select a mode. Bypass permissions requires confirmation. Escape closes the menu and returns focus. Tab closes the menu and moves to the next control.'),
				() => {
					if (menu.isConnected && !menu.inert) { this.actionWidget.focus(); }
					else if (this.element.isConnected) { this.focus(); }
				}, AccessibilityVerbositySettingId.Chat,
			) : undefined,
		}));
		return popup;
	}
}
