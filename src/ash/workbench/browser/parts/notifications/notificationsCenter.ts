import "./media/notifications.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { createServiceIdentifier, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IContextKeyService, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { localize } from "../../../../nls.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { StatusbarAlignment, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { NotificationsToasts } from "./notificationsToasts.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";
import { CopyNotificationMessageAction } from './notificationsActions.js';
import type { NotificationActionRunner } from './notificationsCommands.js';
import { NotificationRenderer } from './notificationsViewer.js';

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
	private readonly clearButton: HTMLButtonElement;
	private readonly toggleButton?: Button;
	private open = false;
	private previousFocus: Element | null = null;
	private readonly copyAction: CopyNotificationMessageAction;
	private copyMenu: CancellationTokenSource | undefined;
	private readonly renderers = this._register(new DisposableMap<number, NotificationRenderer>());

	constructor(
		root: HTMLElement,
		toastContainer: HTMLElement,
		private readonly actionRunner: NotificationActionRunner,
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
		const toasts = this._register(new NotificationsToasts(toastContainer, service, actionRunner));
		this.panel = h(document, "section"); this.panel.className = "ash-notifications-center";
		this.panel.tabIndex = -1;
		this.panel.style.setProperty("--ash-feedback-statusbar-height", `${statusbar ? StatusbarHeight : 0}px`);
		this.panel.setAttribute("role", "region"); this.panel.setAttribute("aria-label", localize('notifications.center', 'Notification Center'));
		this.panel.hidden = true;
		const header = h(document, "div"); header.className = "ash-notifications-center-header";
		const title = h(document, "h2"); title.textContent = localize('notifications.title', 'Notifications');
		header.append(title);
		const clear = this._register(new Button(header, { label: localize('notifications.clearAll', 'Clear All'), presentation: 'quiet', size: 'small' }));
		this.clearButton = clear.domNode; this.clearButton.classList.add('ash-notifications-clear');
		const hide = this._register(new Button(header, { label: localize('notifications.hideCenter', 'Hide Notification Center'), icon: Lxicon.close, iconOnly: true, presentation: 'quiet', size: 'small' }));
		hide.domNode.classList.add('ash-notifications-hide');
		this.list = h(document, "div"); this.list.className = "ash-notifications-list"; this.list.setAttribute("role", "list");
		this.panel.append(header, this.list); root.append(this.panel);
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
		this._register(clear.onDidClick(() => this.clearAll()));
		this._register(hide.onDidClick(() => this.hide()));
		this._register(addDisposableListener(this.list, "click", event => {
			const Element = document.defaultView?.Element;
			const target = event.target;
			if (!Element || !(target instanceof Element)) return;
			const remove = target.closest<HTMLButtonElement>("[data-notification-remove]");
			if (remove) service.remove(Number(remove.dataset.notificationRemove));
		}));
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
		this._register(addDisposableListener(document, "keydown", onEscape, true));
		if (statusbar) {
			const entry = () => ({ icon: this.service.getNotifications().length ? Lxicon.bellDot : Lxicon.bell, text: "", ariaLabel: localize('notifications.showCenter', 'Show Notification Center'), tooltip: localize('notifications.showCenter', 'Show Notification Center'), run: () => this.toggle() });
			const bell = this._register(statusbar.addEntry(entry(), { id: "ash.status.notifications", alignment: StatusbarAlignment.Right, priority: 500 }));
			this._register(service.onDidAdd(() => bell.update(entry())));
			this._register(service.onDidRemove(() => bell.update(entry())));
		} else {
			const toggle = this._register(new Button(root, { label: localize('notifications.title', 'Notifications'), ariaLabel: localize('notifications.showCenter', 'Show Notification Center'), presentation: 'quiet', size: 'small' }));
			this.toggleButton = toggle; toggle.toggleClassName('ash-notifications-toggle', true);
			this._register(toggle.onDidClick(() => this.toggle()));
		}
		this.toasts = toasts;
		this.render();
	}

	private readonly toasts: NotificationsToasts;

	show(): void {
		if (this.isDisposed) return;
		if (this.open) { this.panel.focus(); return; }
		this.previousFocus = this.panel.ownerDocument.activeElement;
		this.open = true; this.panel.hidden = false; this.toasts.setHidden(true);
		this.render(); this.panel.focus();
	}

	hide(): void {
		if (this.isDisposed || !this.open) return;
		this.cancelCopyMenu();
		const document = this.panel.ownerDocument;
		const restoreFocus = this.panel.contains(document.activeElement);
		const previousFocus = this.previousFocus;
		this.previousFocus = null;
		this.open = false; this.panel.hidden = true; this.toasts.setHidden(false);
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
		if (this.isDisposed) return;
		this.cancelCopyMenu();
		const document = this.panel.ownerDocument;
		const focusedRow = document.activeElement?.closest<HTMLElement>("[data-notification-id]");
		const focusedId = this.list.contains(focusedRow ?? null) ? focusedRow?.dataset.notificationId : undefined;
		const items = this.service.getNotifications().slice().reverse();
		this.clearButton.disabled = items.length === 0;
		if (this.toggleButton) this.toggleButton.hidden = items.length === 0;
		this.list.querySelector('.ash-notifications-empty')?.remove();
		for (const id of this.renderers.keys()) {
			if (!items.some(item => item.id === id)) this.renderers.deleteAndDispose(id);
		}
		// Immutable records retain their controls through background updates.
		for (const [index, item] of items.entries()) {
			const renderer = this.renderers.get(item.id) ?? this.renderers.set(item.id, new NotificationRenderer(document, item, 'center', this.actionRunner));
			if (this.list.children[index] !== renderer.domNode) this.list.insertBefore(renderer.domNode, this.list.children[index] ?? null);
		}
		if (!items.length) { const empty = h(document, "p"); empty.className = "ash-notifications-empty"; empty.textContent = localize('notifications.empty', 'No notifications'); this.list.append(empty); }
		if (focusedId && this.open && document.activeElement === document.body) {
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
