import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import "./media/notificationsCenter.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Separator, type IAction, type IActionRunner } from "../../../../base/common/actions.js";
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { createServiceIdentifier, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IContextKeyService, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import { localize } from "../../../../nls.js";
import { INotificationService, NotificationsFilter } from '../../../../platform/notification/common/notification.js';
import { getNotificationsPosition, NotificationsSettings, type NotificationsModel } from '../../../common/notifications.js';
import type { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { NotificationsToasts } from "./notificationsToasts.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { NotificationsAlerts } from "./notificationsAlerts.js";
import { NotificationsStatus } from "./notificationsStatus.js";
import { NotificationsList } from "./notificationsList.js";
import { CopyNotificationMessageAction } from './notificationsActions.js';

export interface INotificationsCenter {
	readonly model: NotificationsModel;
	show(): void;
	hide(): void;
	toggle(): void;
	clearAll(): void;
}
export const INotificationsCenter = createServiceIdentifier<INotificationsCenter>("notificationsCenter");
export const NotificationsFocusedContext = new RawContextKey<boolean>("notificationsFocus", false);

/** One window's notification presentation and history controls. */
export class NotificationsCenter extends Disposable implements INotificationsCenter {
	private readonly panel: HTMLElement;
	private readonly list: HTMLElement;
	private readonly clearButton: Button;
	private readonly notificationList: NotificationsList;
	private readonly status: NotificationsStatus;
	private open = false;
	private previousFocus: Element | null = null;
	private readonly copyAction: CopyNotificationMessageAction;
	private copyMenu: CancellationTokenSource | undefined;
	private contextMenuVisible = false;
	private readonly itemChanges = this._register(new DisposableMap<number>());

	constructor(
		root: HTMLElement,
		readonly model: NotificationsModel,
		toastContainer: HTMLElement,
		private readonly actionRunner: IActionRunner,
		statusbar: IStatusbarService | undefined,
		getHelpHint: (() => string | undefined) | undefined,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService configurationService: IConfigurationService,
		@ILayoutService private readonly layoutService: ILayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IMenuService menuService: IMenuService,
	) {
		super();
		this.copyAction = instantiationService.createInstance(CopyNotificationMessageAction, CopyNotificationMessageAction.ID, CopyNotificationMessageAction.LABEL);
		const document = root.ownerDocument;
		const toasts = this._register(instantiationService.createInstance(NotificationsToasts, toastContainer, this.model, actionRunner));
		this._register(instantiationService.createInstance(NotificationsAlerts, this.model));
		this.panel = h(document, "section"); this.panel.className = "ash-notifications-center";
		this.panel.tabIndex = -1;
		this.panel.style.setProperty("--ash-feedback-statusbar-height", `${statusbar ? StatusbarHeight : 0}px`);
		this.panel.setAttribute("role", "region"); this.panel.setAttribute("aria-label", localize('notifications.center', 'Notification Center'));
		this.panel.hidden = true;
		const updatePosition = (): void => {
			const position = getNotificationsPosition(configurationService);
			contextKeys.setContext(`config.${NotificationsSettings.NOTIFICATIONS_POSITION}`, position);
			contextKeys.setContext(`config.${NotificationsSettings.NOTIFICATIONS_BUTTON}`, configurationService.getValue<boolean>(NotificationsSettings.NOTIFICATIONS_BUTTON) !== false);
			this.panel.dataset.position = position;
			toasts.setPosition(position, layoutService.mainContainerOffset.top);
			this.panel.style.setProperty('--ash-notifications-top', `${layoutService.mainContainerOffset.top + 8}px`);
			const statusbarVisible = statusbar && configurationService.getValue<boolean>('workbench.statusBar.visible') !== false;
			this.panel.style.setProperty('--ash-feedback-statusbar-height', `${statusbarVisible ? StatusbarHeight : 0}px`);
			toastContainer.style.setProperty('--ash-feedback-statusbar-height', `${statusbarVisible ? StatusbarHeight : 0}px`);
		};
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(NotificationsSettings.NOTIFICATIONS_POSITION) || event.affectsConfiguration(NotificationsSettings.NOTIFICATIONS_BUTTON) || event.affectsConfiguration('workbench.statusBar.visible')) updatePosition();
		}));
		this._register(layoutService.onDidLayoutMainContainer(updatePosition));
		this._register(toDisposable(() => {
			contextKeys.removeContext(`config.${NotificationsSettings.NOTIFICATIONS_POSITION}`);
			contextKeys.removeContext(`config.${NotificationsSettings.NOTIFICATIONS_BUTTON}`);
		}));
		updatePosition();
		const header = h(document, "div"); header.className = "ash-notifications-center-header";
		const title = h(document, "h2"); title.textContent = localize('notifications.title', 'Notifications');
		this.clearButton = this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('notifications.clearAll', 'Clear All'),
			presentation: "secondary",
			onClick: () => this.clearAll(),
		}));
		this.clearButton.domNode.classList.add("ash-notifications-clear");
		const doNotDisturb = this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('notifications.toggleDoNotDisturb', 'Toggle Do Not Disturb Mode'),
			icon: Lxicon.bellSlash,
			iconOnly: true,
			onClick: () => this.showHeaderMenu(doNotDisturb, this.getDoNotDisturbActions()),
		}));
		doNotDisturb.domNode.setAttribute('aria-haspopup', 'menu');
		const updateDoNotDisturb = (): void => {
			const muted = notificationService.getFilter() === NotificationsFilter.ERROR;
			doNotDisturb.label = localize('notifications.configureDoNotDisturb', 'Configure Do Not Disturb...');
			doNotDisturb.setTitle(doNotDisturb.label);
			doNotDisturb.checked = muted;
		};
		this._register(notificationService.onDidChangeFilter(updateDoNotDisturb));
		updateDoNotDisturb();
		const positionMenu = this._register(menuService.createMenu(MenuId.NotificationsCenterPositionMenu, contextKeys));
		const position = this._register(new Button(header, {
			...defaultButtonStyles, icon: Lxicon.arrowSwap, iconOnly: true,
			label: localize('notifications.configurePosition', 'Configure Notifications Position...'),
			onClick: () => this.showHeaderMenu(position, positionMenu.getActions().flatMap(([, actions]) => actions)),
		}));
		position.domNode.setAttribute('aria-haspopup', 'menu');
		for (const [button, actions] of [
			[doNotDisturb, () => this.getDoNotDisturbActions()],
			[position, () => positionMenu.getActions().flatMap(([, actions]) => actions)],
		] as const) {
			button.domNode.setAttribute('aria-expanded', 'false');
			this._register(addDisposableListener(button.domNode, 'keydown', event => {
				if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
				event.preventDefault();
				this.showHeaderMenu(button, actions());
			}));
		}
		const hide = this._register(new Button(header, {
			...defaultButtonStyles,
			label: localize('notifications.hideCenter', 'Hide Notification Center'),
			icon: Lxicon.close,
			iconOnly: true,
			onClick: () => this.hide(),
		}));
		hide.domNode.classList.add("ash-notifications-hide");
		header.prepend(title);
		this.panel.append(header);
		this.notificationList = this._register(instantiationService.createInstance(NotificationsList, this.panel, "center", actionRunner));
		this.list = this.notificationList.domNode;
		root.append(this.panel);
		this._register(toDisposable(() => this.panel.remove()));
		const focused = NotificationsFocusedContext.bindTo(contextKeys);
		this._register(addDisposableListener(this.panel, "focusin", () => {
			focused.set(true);
			const hint = getHelpHint?.();
			if (hint) this.panel.setAttribute("aria-description", hint);
			else this.panel.removeAttribute("aria-description");
		}));
		this._register(addDisposableListener(this.panel, "focusout", event => {
			if (!this.panel.contains(event.relatedTarget as Node | null)) focused.reset();
		}));
		this._register(toDisposable(() => focused.reset()));
		this._register(this.notificationList.onDidRequestRemove(id => { if (!model.get(id)?.hasActiveProgress) model.remove(id); }));
		const observe = (item: import('../../../common/notifications.js').NotificationItem): void => {
			this.itemChanges.set(item.id, item.onDidChange(() => { this.clearButton.enabled = model.getNotifications().some(item => !item.hasActiveProgress); }));
		};
		for (const item of model.getNotifications()) observe(item);
		this._register(model.onDidAdd(item => { observe(item); this.render(); }));
		this._register(model.onDidRemove(item => {
			this.itemChanges.deleteAndDispose(item.id);
			// Close before replacing focused rows; an explicitly opened empty center stays open.
			if (this.open && model.getNotifications().length === 0) this.hide();
			this.render();
		}));
		this._register(addDisposableListener(this.panel, "keydown", event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showCopyMenu(event);
			if (event.key === "Delete") {
				const target = event.target as HTMLElement;
				const row = target.closest<HTMLElement>("[data-notification-id]");
				if (row) { event.preventDefault(); const id = Number(row.dataset.notificationId); if (!model.get(id)?.hasActiveProgress) model.remove(id); }
			}
		}));
		this._register(addDisposableListener(this.list, 'contextmenu', event => this.showCopyMenu(event)));
		this._register(contextMenuService.onDidShowContextMenu(() => { this.contextMenuVisible = true; }));
		this._register(contextMenuService.onDidHideContextMenu(() => { this.contextMenuVisible = false; }));
		const onEscape = (event: KeyboardEvent): void => {
			if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
			const dialogHasFocus = Boolean(document.activeElement?.closest('[role="dialog"]'));
			const accessibleDialogOpen = Boolean(document.querySelector('.ash-accessible-view-dialog'));
			if (this.open && event.key === "Escape" && !this.contextMenuVisible && !this.copyMenu && !dialogHasFocus && !accessibleDialogOpen) {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
			}
		};
		this._register(addDisposableListener(document, 'keydown', onEscape, true));
		this.status = this._register(instantiationService.createInstance(NotificationsStatus, root, model, statusbar, () => this.toggle()));
		this._register(toasts.onDidChangeVisibility(visible => this.status.update(this.open, visible)));
		this.status.update(false, toasts.isVisible);
		this.toasts = toasts;
		this.render();
	}

	private readonly toasts: NotificationsToasts;

	show(): void {
		if (this.isDisposed) return;
		if (this.open) { this.panel.focus(); return; }
		this.previousFocus = this.panel.ownerDocument.activeElement;
		this.open = true; this.panel.hidden = false; this.toasts.setHidden(true);
		this.render(); this.status.update(true, this.toasts.isVisible); this.panel.focus();
	}

	hide(): void {
		if (this.isDisposed || !this.open) return;
		this.cancelCopyMenu();
		const document = this.panel.ownerDocument;
		const restoreFocus = this.panel.contains(document.activeElement);
		const previousFocus = this.previousFocus;
		this.previousFocus = null;
		this.open = false; this.panel.hidden = true;
		this.render();
		this.toasts.setHidden(false); this.status.update(false, this.toasts.isVisible);
		if (restoreFocus && previousFocus instanceof document.defaultView!.HTMLElement && previousFocus.isConnected) previousFocus.focus();
		else if (restoreFocus) this.layoutService.focus();
	}

	toggle(): void { if (this.open) this.hide(); else this.show(); }

	clearAll(): void {
		if (this.isDisposed) return;
		// Focus and removal callbacks can add records or reopen the center during this operation.
		const items = this.model.getNotifications().filter(item => !item.hasActiveProgress);
		this.hide();
		for (const item of items) {
			// Restoring focus can start progress on a record selected for clearing.
			if (!this.model.get(item.id)?.hasActiveProgress) this.model.remove(item.id);
		}
	}

	protected override disposeCore(): void {
		this.cancelCopyMenu();
		this.open = false;
		this.previousFocus = null;
		super.disposeCore();
	}

	private render(): void {
		// History changes invalidate this center's pending copy-menu presentation.
		this.cancelCopyMenu();
		const document = this.panel.ownerDocument;
		const focusedRow = document.activeElement?.closest<HTMLElement>("[data-notification-id]");
		const focusedId = this.list.contains(focusedRow ?? null) ? focusedRow?.dataset.notificationId : undefined;
		const items = this.model.getNotifications().slice().reverse();
		this.clearButton.enabled = items.some(item => !item.hasActiveProgress);
		this.notificationList.updateNotificationsList(0, this.list.children.length, items);
		if (focusedId && this.open) {
			(this.list.querySelector<HTMLElement>(`[data-notification-id="${focusedId}"]`) ?? this.list.querySelector<HTMLElement>("[data-notification-id]") ?? this.panel).focus();
		}
	}

	private showCopyMenu(event: MouseEvent | KeyboardEvent): void {
		if (this.isDisposed || !this.open) return;
		const document = this.panel.ownerDocument;
		const Element = document.defaultView?.Element;
		if (!Element || !(event.target instanceof Element)) return;
		const row = event.target.closest<HTMLElement>('[data-notification-id]');
		if (!row || !this.list.contains(row)) return;
		const item = this.model.getNotifications().find(item => item.id === Number(row.dataset.notificationId));
		if (!item) return;
		event.preventDefault();
		event.stopPropagation();
		this.cancelCopyMenu();
		row.focus();
		const source = this.copyMenu = new CancellationTokenSource();
		try {
			this.contextMenuService.showContextMenu({
				getAnchor: () => event.type === 'contextmenu' ? { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, targetWindow: document.defaultView ?? undefined } : row,
				getActions: () => [this.copyAction],
				getActionsContext: () => item,
				cancellationToken: source.token,
				autoSelectFirstItem: true,
				onHide: () => {
					if (this.copyMenu === source) this.copyMenu = undefined;
					// Selection releases the presentation without canceling the started clipboard write.
					source.dispose();
				},
			});
		} catch (error) {
			if (this.copyMenu === source) this.cancelCopyMenu();
			throw error;
		}
	}

	private cancelCopyMenu(): void {
		const source = this.copyMenu;
		this.copyMenu = undefined;
		source?.dispose(true);
	}

	private getDoNotDisturbActions(): IAction[] {
		const service = this.notificationService;
		const muted = service.getFilter() === NotificationsFilter.ERROR;
		const label = muted ? localize('notifications.disableDoNotDisturb', 'Disable Do Not Disturb Mode') : localize('notifications.enableDoNotDisturb', 'Enable Do Not Disturb Mode');
		const actions: IAction[] = [{ id: 'notifications.toggleDoNotDisturbMode', label, tooltip: label, enabled: true, run: () => service.setFilter(muted ? NotificationsFilter.OFF : NotificationsFilter.ERROR) }];
		const sources = service.getFilters().sort((a, b) => a.label.localeCompare(b.label));
		if (sources.length) actions.push(new Separator());
		for (const [index, source] of sources.slice(0, 10).entries()) {
			actions.push({
				id: `notifications.source.${index}`, label: source.label, tooltip: source.label, enabled: true, checked: source.filter === NotificationsFilter.OFF,
				run: () => service.setFilter({ ...source, filter: service.getFilter(source) === NotificationsFilter.OFF ? NotificationsFilter.ERROR : NotificationsFilter.OFF })
			});
		}
		if (sources.length > 10) actions.push(new Separator(), { id: 'notifications.moreSources', label: localize('notifications.moreSources', 'More...'), tooltip: '', enabled: true, run: () => this.commandService.executeCommand('notifications.toggleDoNotDisturbModeBySource') });
		return actions;
	}

	private showHeaderMenu(button: Button, actions: readonly IAction[]): void {
		this.cancelCopyMenu();
		const source = this.copyMenu = new CancellationTokenSource();
		button.domNode.setAttribute('aria-expanded', 'true');
		try {
			this.contextMenuService.showContextMenu({
				getAnchor: () => button.domNode, getActions: () => actions, actionRunner: this.actionRunner, autoSelectFirstItem: true, cancellationToken: source.token,
				onHide: () => {
					if (this.copyMenu === source) this.copyMenu = undefined;
					source.dispose();
					button.domNode.setAttribute('aria-expanded', 'false');
				},
			});
		} catch (error) {
			button.domNode.setAttribute('aria-expanded', 'false');
			if (this.copyMenu === source) this.cancelCopyMenu();
			throw error;
		}
	}

}
