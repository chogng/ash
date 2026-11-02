import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { getTabbableElements } from '../../../../../../base/browser/focus.js';
import { ButtonActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorPosition } from '../../../../../../base/browser/ui/contextview/contextview.js';
import type { IManagedHover } from '../../../../../../base/browser/ui/hover/hoverDelegate.js';
import { KeybindingLabel } from '../../../../../../base/browser/ui/keybindinglabel/keybindinglabel.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import type { Event } from '../../../../../../base/common/event.js';
import { Keybinding, logicalKey, resolveKeybinding } from '../../../../../../base/common/keybindings.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActionListItemKind } from '../../../../../../platform/actionWidget/browser/actionList.js';
import { IActionWidgetService } from '../../../../../../platform/actionWidget/browser/actionWidget.js';
import type { IActionWidgetDropdownActionProvider } from '../../../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultKeybindingLabelStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { trackChatInputPickerFocus } from './pickers/chatInputPickerActionItem.js';
import './media/chatInputPicker.css';

/** Shared permission presentation; the composer owns the selected mode and confirmation policy. */
export class PermissionPickerActionItem extends ButtonActionViewItem {
	private readonly popup = this._register(new DisposableStore());
	private hover: IManagedHover | undefined;
	private visible = false;
	private opening: object | undefined;

	constructor(
		action: IAction,
		private readonly onDidChange: Event<void>,
		private readonly actionProvider: IActionWidgetDropdownActionProvider,
		@IActionWidgetService private readonly actionWidget: IActionWidgetService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(action, { buttonStyles: defaultButtonStyles, buttonPresentation: 'quiet' });
		this._register(toDisposable(() => this.hide()));
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.classList.add('ash-chat-input-permission-picker');
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this._register(trackChatInputPickerFocus(container));
		this._register(addDisposableListener(this.button.domNode, 'keydown', event => {
			if (!event.isComposing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				stopEvent(event);
				this.show();
			}
		}));
		const update = (): void => {
			this.hide();
			this.button.label = this.action.label;
			this.button.enabled = this.action.enabled;
			this.button.domNode.setAttribute('aria-label', this.action.tooltip);
			this.hover?.update(this.action.tooltip);
			this.setTabbable(true);
		};
		this._register(this.onDidChange(update));
		update();
	}

	protected override setupTooltip(): void {
		this.hover = this.setupHover(this.button.domNode, this.action.tooltip);
	}

	protected override runAction(): void {
		this.button.focus();
		if (this.visible || this.opening) { this.hide(); }
		else { this.show(); }
	}

	public override setTabbable(_tabbable: boolean): void {
		this.button.domNode.tabIndex = this.action.enabled ? 0 : -1;
	}

	public show(anchor?: HTMLElement): void {
		if (this.isDisposed || this.visible || this.opening || !this.action.enabled) { return; }
		const request = this.opening = {};
		void this.readActions(request, anchor ?? this.button.domNode).catch(error => this.notifications.error(error));
	}

	private async readActions(request: object, anchor: HTMLElement): Promise<void> {
		let actions: readonly IAction[];
		try { actions = await this.actionProvider.getActions(); }
		catch (error) {
			if (this.opening === request) { this.opening = undefined; }
			throw error;
		}
		if (this.opening !== request || this.isDisposed || !this.action.enabled) { return; }
		this.opening = undefined;
		if (!actions.length) { return; }
		this.button.focus();
		const heading = h(anchor.ownerDocument, 'div');
		heading.className = 'ash-chat-permission-heading';
		heading.textContent = localize('chat.input.permissions', 'Permissions');
		const select = async (action: IAction): Promise<void> => {
			if (!action.enabled) { return; }
			this.hide();
			try { await action.run(); }
			catch (error) { this.notifications.error(error instanceof Error ? error : String(error)); }
		};
		this.visible = true;
		this.button.domNode.setAttribute('aria-expanded', 'true');
		this.actionWidget.show('chatPermissions', false, actions.map(action => ({
			kind: ActionListItemKind.Action, item: action, label: action.label,
			description: action.tooltip, disabled: !action.enabled, checked: action.checked,
		})), {
			onSelect: select,
			onHide: () => {
				this.visible = false;
				this.button.domNode.setAttribute('aria-expanded', 'false');
				this.popup.clear();
			},
			onShow: menu => {
				const buttons = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
				for (const [index, button] of buttons.entries()) {
					button.setAttribute('aria-keyshortcuts', String(index + 1));
					const shortcut = this.popup.add(new KeybindingLabel(button, {
						...defaultKeybindingLabelStyles,
						keybinding: resolveKeybinding(Keybinding.single(logicalKey(String(index + 1)))),
						presentation: 'keycap',
					}));
					shortcut.element.setAttribute('aria-hidden', 'true');
				}
				this.popup.add(addDisposableListener(menu, 'keydown', event => {
					if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) { return; }
					if (/^[123]$/u.test(event.key)) {
						stopEvent(event);
						const action = actions[Number(event.key) - 1];
						if (action) { void select(action); }
					} else if (event.key === 'Tab') {
						stopEvent(event);
						this.hide();
						const controls = getTabbableElements(this.button.domNode.ownerDocument.body);
						const next = controls.indexOf(this.button.domNode) + (event.shiftKey ? -1 : 1);
						controls[next]?.focus();
					}
				}, true));
				this.popup.add(AccessibleViewRegistry.register({
					type: AccessibleViewType.Help, priority: 110, name: 'chat-permissions',
					getProvider: () => menu.contains(menu.ownerDocument.activeElement) ? new AccessibleContentProvider(
						AccessibleViewProviderId.ActionWidget, { type: AccessibleViewType.Help },
						() => localize('chat.input.permissionsHelp', 'Permissions menu\nUse Up and Down Arrow, Home and End to choose a permission mode. Press Enter or Space to select it. While this menu is open, press 1, 2, or 3 to select a mode. Bypass permissions requires confirmation. Escape closes the menu and returns focus. Tab closes the menu and moves to the next control.'),
						() => {
							if (menu.isConnected) { this.actionWidget.focus(); }
							else if (this.button.domNode.isConnected) { this.button.focus(); }
						}, AccessibilityVerbositySettingId.Chat,
					) : undefined,
				}));
			},
		}, anchor, {
			presentation: 'details', className: 'ash-chat-permission-menu', header: heading,
			ariaLabel: heading.textContent, minWidth: 370, maxWidth: 370, anchorPosition: AnchorPosition.Above,
			accessibilityHelp: () => this.accessibleViews.show(AccessibleViewType.Help),
		});
	}

	public hide(): void {
		this.opening = undefined;
		if (this.visible) { this.actionWidget.hide(); }
	}
}
