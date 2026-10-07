import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import type { IAction, IActionRunner } from "../../../../base/common/actions.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { NotificationSeverity, type INotificationService, type NotificationItem } from "../../../../platform/notification/common/notification.js";

/** Transient presentation of notification history. Explicit removal clears the shared record. */
export class NotificationsToasts extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly visible = new Set<number>();
	private hidden = false;
	private previousFocus: HTMLElement | undefined;

	constructor(container: HTMLElement, private readonly service: INotificationService, private readonly actionRunner: IActionRunner) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, "div");
		this.element.className = "ash-notification-host";
		this.element.setAttribute("role", "region");
		this.element.setAttribute("aria-label", localize('notifications.toasts', 'Notifications'));
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(service.onDidAdd(item => {
			this.visible.add(item.id);
			if (this.visible.size > 3) this.visible.delete(this.visible.values().next().value!);
			this.render();
		}));
		this._register(service.onDidRemove(item => { this.visible.delete(item.id); this.render(); }));
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
			this.render();
			// DOM removal can transfer ownership of focus or dispose this window's presentation.
			if (!this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body && previousFocus?.isConnected && !previousFocus.closest("[hidden], [inert], [aria-hidden='true']") && !previousFocus.matches(":disabled") && previousFocus.checkVisibility({ checkVisibilityCSS: true })) {
				previousFocus.focus();
			}
		}));
		this._register(addDisposableListener(this.element, "click", event => {
			const target = event.target;
			const Element = document.defaultView?.Element;
			if (!Element || !(target instanceof Element)) return;
			const button = target.closest<HTMLButtonElement>("[data-notification-close]");
			if (button) {
				const buttons = [...this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]")];
				const focusedIndex = document.activeElement === button ? buttons.indexOf(button) : -1;
				service.remove(Number(button.dataset.notificationClose));
				// Removal listeners can open the center, move focus, or dispose this owner.
				if (focusedIndex >= 0 && !this.hidden && !this.isDisposed && this.element.isConnected && document.activeElement === document.body) {
					const remaining = this.element.querySelectorAll<HTMLButtonElement>("[data-notification-close]");
					const nextFocus = remaining[Math.min(focusedIndex, remaining.length - 1)] ?? this.previousFocus;
					if (nextFocus?.isConnected) nextFocus.focus();
				}
			}
		}));
		for (const item of service.getNotifications().slice(-3)) this.visible.add(item.id);
		this.render();
	}

	setHidden(hidden: boolean): void {
		if (hidden && !this.hidden) this.visible.clear();
		this.hidden = hidden;
		this.render();
	}

	private render(): void {
		if (this.isDisposed) return;
		if (this.hidden) { this.element.replaceChildren(); return; }
		const document = this.element.ownerDocument;
		const items = this.service.getNotifications().filter(item => this.visible.has(item.id));
		for (const toast of [...this.element.children] as HTMLElement[]) {
			if (!items.some(item => item.id === Number(toast.dataset.notificationId))) toast.remove();
		}
		// Records are immutable and append-ordered. Retain their controls so background
		// changes preserve focus without refocusing across another owner's transition.
		for (const item of items) {
			if (this.hidden || this.isDisposed) return;
			if (!this.element.querySelector(`[data-notification-id="${item.id}"]`)) this.element.append(this.renderItem(document, item));
		}
	}

	private renderItem(document: Document, item: NotificationItem): HTMLElement {
		const notification = h(document, "article");
		notification.className = `ash-notification ash-notification-${item.severity}`;
		notification.dataset.notificationId = String(item.id);
		notification.setAttribute("role", item.severity === NotificationSeverity.Error ? "alert" : "status");
		const content = h(document, "div");
		content.className = "ash-notification-content";
		const message = h(document, "div");
		message.className = "ash-notification-message";
		message.textContent = item.message;
		content.append(message);
		if (item.source) { const source = h(document, "div"); source.className = "ash-notification-source"; source.textContent = item.source; content.append(source); }
		if (item.actions?.length) {
			const actions = h(document, "div"); actions.className = "ash-notification-actions";
			for (const action of item.actions) {
				const button = h(document, "button"); button.type = "button"; button.className = "ash-notification-action"; button.textContent = action.label;
				const notificationAction: IAction = {
					id: action.id, label: action.label, tooltip: "", enabled: true,
					run: () => action.run(),
				};
				button.addEventListener("click", () => { void Promise.resolve().then(() => this.actionRunner.run(notificationAction)); });
				actions.append(button);
			}
			content.append(actions);
		}
		const close = h(document, "button"); close.type = "button"; close.className = "ash-notification-close"; close.dataset.notificationClose = String(item.id);
		close.setAttribute("aria-label", localize('notifications.remove', 'Remove notification')); close.textContent = "×";
		notification.append(content, close);
		return notification;
	}
}
