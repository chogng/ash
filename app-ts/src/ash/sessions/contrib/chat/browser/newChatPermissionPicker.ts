import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IApprovalEnvironmentService } from '../../../../platform/approvalEnvironment/common/approvalEnvironmentService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { approvalModeDefinitions } from '../../../../platform/sessions/common/approvalModes.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { OPEN_GUARDIAN_SETUP_COMMAND_ID } from '../../../../workbench/contrib/chat/common/chat.js';
import { SessionsChatAccessibilityHelp } from './sessionsChatAccessibilityHelp.js';

/** Owns only the open popup's input; numeric keys never register against the editor or window. */
export class NewChatPermissionPicker extends Disposable {
	private visible = false;
	private readonly listeners = this._register(new DisposableStore());

	constructor(
		private readonly button: HTMLButtonElement,
		private readonly model: IChatWidgetModel,
		@IContextViewService private readonly views: IContextViewService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService private readonly services: IInstantiationService,
	) {
		super();
		this._register(model.onDidChange(() => { if (this.visible) this.views.hide(); }));
		this._register(addDisposableListener(button, 'click', () => this.visible ? this.views.hide() : this.show()));
		this._register(addDisposableListener(button, 'keydown', event => {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				this.show();
			}
		}));
		this._register(toDisposable(() => { if (this.visible) this.views.hide(); }));
	}

	private show(): void {
		if (this.visible) return;
		const menu = h(this.button.ownerDocument, 'div');
		menu.className = 'ash-sessions-permission-menu';
		menu.setAttribute('role', 'menu');
		menu.setAttribute('aria-label', localize('sessions.chat.permissions', 'Permissions'));
		const heading = h(menu.ownerDocument, 'div');
		heading.className = 'ash-sessions-permission-heading';
		heading.textContent = localize('sessions.chat.permissions', 'Permissions');
		menu.append(heading);
		const buttons: HTMLButtonElement[] = [];
		let focusedItem: HTMLButtonElement;
		this.listeners.add(AccessibleViewRegistry.register(new SessionsChatAccessibilityHelp(menu, () => focusedItem.focus())));
		this.listeners.add(addDisposableListener(menu, 'focusin', event => { focusedItem = event.target as HTMLButtonElement; }));
		const activate = (command: string): void => {
			this.views.hide();
			void this.commands.executeCommand(command, this.model).catch(error => this.notifications.error(error));
		};
		for (const [index, definition] of approvalModeDefinitions.entries()) {
			const item = h(menu.ownerDocument, 'button');
			item.type = 'button';
			item.tabIndex = -1;
			item.className = 'ash-sessions-permission-item';
			item.setAttribute('role', 'menuitemradio');
			const checked = definition.id === this.model.inputState.approvalMode;
			item.classList.toggle('checked', checked);
			item.setAttribute('aria-checked', String(checked));
			item.setAttribute('aria-keyshortcuts', String(index + 1));
			const label = localize(definition.label.key, definition.label.text);
			item.setAttribute('aria-label', label);
			const text = h(menu.ownerDocument, 'span');
			text.className = 'ash-sessions-permission-text';
			const title = h(menu.ownerDocument, 'span');
			title.textContent = label;
			const description = h(menu.ownerDocument, 'span');
			description.className = 'ash-sessions-permission-description';
			description.id = `permission-${createUuid()}`;
			description.textContent = localize(definition.description.key, definition.description.text);
			item.setAttribute('aria-describedby', description.id);
			text.append(title, description);
			const check = h(menu.ownerDocument, 'span');
			check.className = 'ash-sessions-permission-check';
			check.setAttribute('aria-hidden', 'true');
			appendIcon(Lxicon.check, check);
			const shortcut = h(menu.ownerDocument, 'span');
			shortcut.className = 'ash-sessions-permission-shortcut';
			shortcut.setAttribute('aria-hidden', 'true');
			shortcut.textContent = String(index + 1);
			item.append(text, check, shortcut);
			this.listeners.add(addDisposableListener(item, 'click', () => activate(`sessions.chat.permission.${definition.id}`)));
			menu.append(item);
			buttons.push(item);
		}
		const settings = h(menu.ownerDocument, 'button');
		settings.type = 'button';
		settings.tabIndex = -1;
		settings.className = 'ash-sessions-permission-settings';
		settings.setAttribute('role', 'menuitem');
		settings.textContent = localize('sessions.chat.permission.reviewModel', 'Review model…');
		this.listeners.add(addDisposableListener(settings, 'click', () => activate('sessions.chat.permission.reviewModel')));
		menu.append(settings);
		buttons.push(settings);
		if (this.services.getOptional(IApprovalEnvironmentService)) {
			const environment = h(menu.ownerDocument, 'button');
			environment.type = 'button';
			environment.tabIndex = -1;
			environment.className = 'ash-sessions-permission-settings';
			environment.setAttribute('role', 'menuitem');
			environment.textContent = localize('approvalEnvironment.title', 'Prepare review environment…');
			this.listeners.add(addDisposableListener(environment, 'click', () => activate(OPEN_GUARDIAN_SETUP_COMMAND_ID)));
			menu.append(environment);
			buttons.push(environment);
		}
		this.listeners.add(addDisposableListener(menu, 'keydown', event => {
			if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
			const index = buttons.indexOf(menu.ownerDocument.activeElement as HTMLButtonElement);
			if (/^[123]$/u.test(event.key)) {
				event.preventDefault(); event.stopPropagation();
				buttons[Number(event.key) - 1]!.click();
			} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
				event.preventDefault(); event.stopPropagation();
				const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
					: (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
				buttons[next]!.focus();
			} else if (event.key === 'Tab') {
				event.stopPropagation(); this.views.hide();
			} else if (event.key === 'Escape') {
				event.preventDefault(); event.stopPropagation(); this.views.hide();
			}
		}));
		this.visible = this.views.show({ anchor: this.button, content: menu, presentation: 'menu', focusRestore: ContextViewFocusRestore.Previous, onHide: () => {
			this.visible = false;
			this.button.setAttribute('aria-expanded', 'false');
			this.listeners.clear();
		} });
		this.button.setAttribute('aria-expanded', String(this.visible));
		if (this.visible) buttons[approvalModeDefinitions.findIndex(definition => definition.id === this.model.inputState.approvalMode)]!.focus();
	}
}
