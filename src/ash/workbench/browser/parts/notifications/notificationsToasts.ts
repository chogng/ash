import "./media/notificationsToasts.css";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import type { IActionRunner } from "../../../../base/common/actions.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { NotificationPriority, type INotificationService } from "../../../../platform/notification/common/notification.js";

import { NotificationsList } from "./notificationsList.js";
import { PendingNotificationToasts } from "./pendingNotificationToasts.js";

/** Transient presentation of notification history. Explicit removal clears the shared record. */
export class NotificationsToasts extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly visible = new Set<number>();
	private readonly list: NotificationsList;
	private readonly pending: PendingNotificationToasts<number>;
	private hidden = false;
	private previousFocus: HTMLElement | undefined;

	constructor(container: HTMLElement, private readonly service: INotificationService, actionRunner: IActionRunner, @IInstantiationService instantiationService: IInstantiationService) {
		super();
		const document = container.ownerDocument;
		this.list = this._register(instantiationService.createInstance(NotificationsList, container, "toast", actionRunner));
		this.element = this.list.domNode;
		this.pending = this._register(new PendingNotificationToasts<number>(
			id => !this.hidden && service.getNotifications().some(current => current.id === id),
			callback => {
				const window = this.element.ownerDocument.defaultView!;
				const frame = window.requestAnimationFrame(callback);
				return toDisposable(() => window.cancelAnimationFrame(frame));
			},
		));
		this._register(service.onDidAdd(item => {
			if (this.hidden || item.priority === NotificationPriority.SILENT) return;
			this.pending.add(item.id, (id, resources) => {
				try {
					this.visible.add(id);
					if (this.visible.size > 3) this.visible.delete(this.visible.values().next().value!);
					this.render();
				} finally { resources.dispose(); }
			});
		}));
		this._register(service.onDidRemove(item => { this.pending.remove(item.id); this.visible.delete(item.id); this.render(); }));
		this._register(addDisposableListener(this.element, "focusin", event => {
			const HTMLElement = document.defaultView?.HTMLElement;
			const target = event.relatedTarget;
			if (HTMLElement && target instanceof HTMLElement && target !== document.body && !this.element.contains(target)) {
				this.previousFocus = target;
			}
		}));
		this._register(addDisposableListener(this.element, "keydown", event => {
			if (event.key !== "Escape" || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || this.hidden || this.isDisposed) return;
			const target = event.target;
			const HTMLButtonElement = document.defaultView?.HTMLButtonElement;
			if (!HTMLButtonElement || !(target instanceof HTMLButtonElement) || target !== document.activeElement || !this.element.isConnected || !target.matches("[data-notification-close]")) return;
			event.preventDefault();
			event.stopPropagation();
			const previousFocus = this.previousFocus;
			// Passive dismissal clears this presentation, leaving the model and future arrivals intact.
			this.visible.clear();
			this.pending.clear();
			this.render();
			// DOM removal can transfer ownership of focus or dispose this window's presentation.
			if (!this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body && previousFocus?.isConnected && !previousFocus.closest("[hidden], [inert], [aria-hidden='true']") && !previousFocus.matches(":disabled") && previousFocus.checkVisibility({ checkVisibilityCSS: true })) {
				previousFocus.focus();
			}
		}));
		this._register(this.list.onDidRequestRemove(id => {
			const button = this.element.querySelector<HTMLButtonElement>(`[data-notification-close="${id}"]`);
			const buttons = [...this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]")];
			const focusedIndex = document.activeElement === button ? buttons.indexOf(button!) : -1;
			service.remove(id);
			// Removal listeners can open the center, move focus, or dispose this owner.
			if (focusedIndex >= 0 && !this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body) {
				const remaining = this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]");
				const nextFocus = remaining[Math.min(focusedIndex, remaining.length - 1)] ?? this.previousFocus;
				if (nextFocus?.isConnected) nextFocus.focus();
			}
		}));
		for (const item of service.getNotifications().filter(item => item.priority !== NotificationPriority.SILENT).slice(-3)) this.visible.add(item.id);
		this.render();
	}

	setHidden(hidden: boolean): void {
		if (hidden && !this.hidden) { this.visible.clear(); this.pending.clear(); }
		this.hidden = hidden;
		this.render();
	}

	private render(): void {
		if (this.isDisposed) return;
		const items = this.hidden ? [] : this.service.getNotifications().filter(item => this.visible.has(item.id));
		this.list.updateNotificationsList(0, this.element.children.length, items);
	}
}
