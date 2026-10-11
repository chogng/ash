import "./media/notificationsCenter.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import type { IActionRunner } from "../../../../base/common/actions.js";
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { createServiceIdentifier, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IContextKeyService, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { localize } from "../../../../nls.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import type { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { NotificationsToasts } from "./notificationsToasts.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { NotificationsAlerts } from "./notificationsAlerts.js";
import { NotificationsStatus } from "./notificationsStatus.js";
import { NotificationsList } from "./notificationsList.js";
import { CopyNotificationMessageAction } from './notificationsActions.js';

export interface INotificationsCenter {
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

	constructor(
		root: HTMLElement,
		toastContainer: HTMLElement,
		actionRunner: IActionRunner,
		statusbar: IStatusbarService | undefined,
		getHelpHint: (() => string | undefined) | undefined,
		@INotificationService private readonly service: INotificationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.copyAction = instantiationService.createInstance(CopyNotificationMessageAction, CopyNotificationMessageAction.ID, CopyNotificationMessageAction.LABEL);
		const document = root.ownerDocument;
		const toasts = this._register(instantiationService.createInstance(NotificationsToasts, toastContainer, service, actionRunner));
		this._register(instantiationService.createInstance(NotificationsAlerts, service));
		this.panel = h(document, "section"); this.panel.className = "ash-notifications-center";
		this.panel.tabIndex = -1;
		this.panel.style.setProperty("--ash-feedback-statusbar-height", `${statusbar ? StatusbarHeight : 0}px`);
		this.panel.setAttribute("role", "region"); this.panel.setAttribute("aria-label", localize('notifications.center', 'Notification Center'));
		this.panel.hidden = true;
		const header = h(document, "div"); header.className = "ash-notifications-center-header";
		const title = h(document, "h2"); title.textContent = localize('notifications.title', 'Notifications');
		this.clearButton = this._register(new Button(header, { label: localize('notifications.clearAll', 'Clear All'), presentation: "secondary", onClick: () => this.clearAll() }));
		this.clearButton.domNode.classList.add("ash-notifications-clear");
		const hide = this._register(new Button(header, { label: localize('notifications.hideCenter', 'Hide Notification Center'), icon: Lxicon.close, iconOnly: true, onClick: () => this.hide() }));
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
		this._register(this.notificationList.onDidRequestRemove(id => service.remove(id)));
		this._register(service.onDidAdd(() => this.render()));
		this._register(service.onDidRemove(() => {
			// Close before replacing focused rows; an explicitly opened empty center stays open.
			if (this.open && service.getNotifications().length === 0) this.hide();
			this.render();
		}));
		this._register(addDisposableListener(this.panel, "keydown", event => {
			if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) this.showCopyMenu(event);
			if (event.key === "Delete") {
				const target = event.target as HTMLElement;
				const row = target.closest<HTMLElement>("[data-notification-id]");
				if (row) { event.preventDefault(); service.remove(Number(row.dataset.notificationId)); }
			}
		}));
		this._register(addDisposableListener(this.list, 'contextmenu', event => this.showCopyMenu(event)));
		const onEscape = (event: KeyboardEvent): void => {
			const dialogHasFocus = Boolean(document.activeElement?.closest('[role="dialog"]'));
			const accessibleDialogOpen = Boolean(document.querySelector('.ash-accessible-view-dialog'));
			if (this.open && event.key === "Escape" && !this.copyMenu && !dialogHasFocus && !accessibleDialogOpen) {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
			}
		};
		document.addEventListener("keydown", onEscape, true);
		this._register(toDisposable(() => document.removeEventListener("keydown", onEscape, true)));
		this.status = this._register(new NotificationsStatus(root, service, statusbar, () => this.toggle()));
		this.toasts = toasts;
		this.render();
	}

	private readonly toasts: NotificationsToasts;

	show(): void {
		if (this.isDisposed) return;
		if (this.open) { this.panel.focus(); return; }
		this.previousFocus = this.panel.ownerDocument.activeElement;
		this.open = true; this.panel.hidden = false; this.toasts.setHidden(true);
		this.render(); this.status.update(true); this.panel.focus();
	}

	hide(): void {
		if (this.isDisposed || !this.open) return;
		this.cancelCopyMenu();
		const document = this.panel.ownerDocument;
		const restoreFocus = this.panel.contains(document.activeElement);
		const previousFocus = this.previousFocus;
		this.previousFocus = null;
		this.open = false; this.panel.hidden = true; this.toasts.setHidden(false); this.status.update(false);
		if (restoreFocus && previousFocus instanceof document.defaultView!.HTMLElement && previousFocus.isConnected) previousFocus.focus();
	}

	toggle(): void { if (this.open) this.hide(); else this.show(); }

	clearAll(): void {
		if (this.isDisposed) return;
		// Focus and removal callbacks can add records or reopen the center during this operation.
		const items = this.service.getNotifications();
		this.hide();
		for (const item of items) this.service.remove(item.id);
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
		const items = this.service.getNotifications().slice().reverse();
		this.clearButton.enabled = items.length > 0;
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
		const item = this.service.getNotifications().find(item => item.id === Number(row.dataset.notificationId));
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

}
