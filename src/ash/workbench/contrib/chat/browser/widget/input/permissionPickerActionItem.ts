import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
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
				menuIconPlacement: 'leading-with-trailing-check',
				showRowTooltips: false,
				ariaLabel: title, minWidth: 370, maxWidth: 370,
				accessibilityHelp: () => accessibleViews.show(AccessibleViewType.Help),
			},
			tabLeavesPopup: true,
			focusItemOnPointerOpen: false,
			onShow: menu => this.registerMenuHelp(menu),
			onError: error => notifications.error(error instanceof Error ? error : String(error)),
		}, instantiationService);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.element.classList.add('ash-chat-input-permission-picker');
		appendIcon(Lxicon.lock, this.element).classList.add('ash-chat-input-permission-icon');
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

	public setCompact(compact: boolean): void {
		this.element.classList.toggle('icon-only', compact);
	}

	private registerMenuHelp(menu: HTMLElement): IDisposable {
		return AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 110, name: 'chat-permissions',
			getProvider: () => menu.contains(menu.ownerDocument.activeElement) ? new AccessibleContentProvider(
				AccessibleViewProviderId.ActionWidget, { type: AccessibleViewType.Help },
				() => localize('chat.input.permissionsHelp', 'Permissions menu\nUse Up and Down Arrow, Home and End to choose a permission mode. Press Enter or Space to select it. Bypass permissions requires confirmation. Escape closes the menu and returns focus. Tab closes the menu and moves to the next control.'),
				() => {
					if (menu.isConnected && !menu.inert) { this.actionWidget.focus(); }
					else if (this.element.isConnected) { this.focus(); }
				}, AccessibilityVerbositySettingId.Chat,
			) : undefined,
		});
	}
}
