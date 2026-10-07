import "./media/notifications.css";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import type { IAction, IActionRunner } from "../../../../base/common/actions.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Lxicon } from "../../../../base/common/lxicons.js";
import { createServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type IContextKeyService, RawContextKey } from "../../../../platform/contextkey/common/contextkey.js";
import { localize } from "../../../../nls.js";
import type { INotificationService, NotificationItem } from "../../../../platform/notification/common/notification.js";
import { StatusbarAlignment, type IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { NotificationsToasts } from "./notificationsToasts.js";
import { StatusbarHeight } from "../workbenchPartDimensions.js";

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
	private readonly toggleButton?: HTMLButtonElement;
	private open = false;
	private previousFocus: Element | null = null;

	constructor(root: HTMLElement, toastContainer: HTMLElement, private readonly service: INotificationService, private readonly actionRunner: IActionRunner, statusbar?: IStatusbarService, contextKeys?: IContextKeyService, getHelpHint?: () => string | undefined) {
		super();
		const document = root.ownerDocument;
		const toasts = this._register(new NotificationsToasts(toastContainer, service, actionRunner));
		this.panel = h(document, "section"); this.panel.className = "ash-notifications-center";
		this.panel.tabIndex = -1;
		this.panel.style.setProperty("--ash-feedback-statusbar-height", `${statusbar ? StatusbarHeight : 0}px`);
		this.panel.setAttribute("role", "region"); this.panel.setAttribute("aria-label", localize('notifications.center', 'Notification Center'));
		this.panel.hidden = true;
		const header = h(document, "div"); header.className = "ash-notifications-center-header";
		const title = h(document, "h2"); title.textContent = localize('notifications.title', 'Notifications');
		this.clearButton = h(document, "button"); this.clearButton.type = "button"; this.clearButton.className = "ash-notifications-clear";
		this.clearButton.textContent = localize('notifications.clearAll', 'Clear All');
		const hide = h(document, "button"); hide.type = "button"; hide.className = "ash-notifications-hide";
		hide.setAttribute("aria-label", localize('notifications.hideCenter', 'Hide Notification Center')); hide.textContent = "×";
		header.append(title, this.clearButton, hide);
		this.list = h(document, "div"); this.list.className = "ash-notifications-list"; this.list.setAttribute("role", "list");
		this.panel.append(header, this.list); root.append(this.panel);
		this._register(toDisposable(() => this.panel.remove()));
		if (contextKeys) {
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
		}
		this._register(addDisposableListener(this.clearButton, "click", () => this.clearAll()));
		this._register(addDisposableListener(hide, "click", () => this.hide()));
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
			if (event.key === "Delete") {
				const target = event.target as HTMLElement;
				const row = target.closest<HTMLElement>("[data-notification-id]");
				if (row) { event.preventDefault(); service.remove(Number(row.dataset.notificationId)); }
			}
		}));
		const onEscape = (event: KeyboardEvent): void => {
			const dialogHasFocus = Boolean(document.activeElement?.closest('[role="dialog"]'));
			const accessibleDialogOpen = Boolean(document.querySelector('.ash-accessible-view-dialog'));
			if (this.open && event.key === "Escape" && !dialogHasFocus && !accessibleDialogOpen) {
				event.preventDefault();
				event.stopPropagation();
				this.hide();
			}
		};
		document.addEventListener("keydown", onEscape, true);
		this._register(toDisposable(() => document.removeEventListener("keydown", onEscape, true)));
		if (statusbar) {
			const entry = () => ({ icon: this.service.getNotifications().length ? Lxicon.bellDot : Lxicon.bell, text: "", ariaLabel: localize('notifications.showCenter', 'Show Notification Center'), tooltip: localize('notifications.showCenter', 'Show Notification Center'), run: () => this.toggle() });
			const bell = this._register(statusbar.addEntry(entry(), { id: "ash.status.notifications", alignment: StatusbarAlignment.Right, priority: 500 }));
			this._register(service.onDidAdd(() => bell.update(entry())));
			this._register(service.onDidRemove(() => bell.update(entry())));
		} else {
			this.toggleButton = h(document, "button"); this.toggleButton.type = "button"; this.toggleButton.className = "ash-notifications-toggle";
			this.toggleButton.textContent = localize('notifications.title', 'Notifications');
			this.toggleButton.setAttribute("aria-label", localize('notifications.showCenter', 'Show Notification Center'));
			root.append(this.toggleButton);
			this._register(toDisposable(() => this.toggleButton?.remove()));
			this._register(addDisposableListener(this.toggleButton, "click", () => this.toggle()));
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
		this.open = false;
		this.previousFocus = null;
		super.disposeCore();
	}

	private render(): void {
		const document = this.panel.ownerDocument;
		const focusedRow = document.activeElement?.closest<HTMLElement>("[data-notification-id]");
		const focusedId = this.list.contains(focusedRow ?? null) ? focusedRow?.dataset.notificationId : undefined;
		const items = this.service.getNotifications().slice().reverse();
		this.clearButton.disabled = items.length === 0;
		if (this.toggleButton) this.toggleButton.hidden = items.length === 0;
		this.list.replaceChildren(...items.map(item => this.renderItem(document, item)));
		if (!items.length) { const empty = h(document, "p"); empty.className = "ash-notifications-empty"; empty.textContent = localize('notifications.empty', 'No notifications'); this.list.append(empty); }
		if (focusedId && this.open) {
			(this.list.querySelector<HTMLElement>(`[data-notification-id="${focusedId}"]`) ?? this.list.querySelector<HTMLElement>("[data-notification-id]") ?? this.panel).focus();
		}
	}

	private renderItem(document: Document, item: NotificationItem): HTMLElement {
		const row = h(document, "article"); row.className = "ash-notifications-row"; row.dataset.notificationId = String(item.id);
		row.setAttribute("role", "listitem"); row.tabIndex = 0;
		const message = h(document, "div"); message.className = "ash-notification-message"; message.textContent = item.message;
		row.append(message);
		if (item.source) { const source = h(document, "div"); source.className = "ash-notification-source"; source.textContent = item.source; row.append(source); }
		if (item.actions?.length) {
			const actions = h(document, "div"); actions.className = "ash-notification-actions";
			for (const action of item.actions) {
				const button = h(document, "button"); button.type = "button"; button.textContent = action.label; button.className = "ash-notification-action";
				const notificationAction: IAction = {
					id: action.id, label: action.label, tooltip: "", enabled: true,
					run: () => action.run(),
				};
				button.addEventListener("click", () => { void Promise.resolve().then(() => this.actionRunner.run(notificationAction)); });
				actions.append(button);
			}
			row.append(actions);
		}
		const remove = h(document, "button"); remove.type = "button"; remove.className = "ash-notifications-remove"; remove.dataset.notificationRemove = String(item.id);
		remove.setAttribute("aria-label", localize('notifications.remove', 'Remove notification')); remove.textContent = "×";
		row.append(remove); return row;
	}
}
