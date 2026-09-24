import { addDisposableListener, h } from "../../../base/browser/dom.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { Emitter, type Event } from "../../../base/common/event.js";
import {
	NotificationSeverity,
	type INotificationService,
	type NotificationAction,
	type NotificationHandle,
	type NotificationItem,
	type NotificationOptions,
} from "../common/notification.js";

/** Browser-backed notification center for one Workbench root. */
export class BrowserNotificationService extends Disposable implements INotificationService {
	private readonly _onDidAdd = this._register(new Emitter<NotificationItem>());
	private readonly _onDidRemove = this._register(new Emitter<NotificationItem>());
	private readonly notifications = new Map<number, NotificationItem>();
	private readonly element: HTMLDivElement;
	private nextId = 1;

	readonly onDidAdd: Event<NotificationItem> = this._onDidAdd.event;
	readonly onDidRemove: Event<NotificationItem> = this._onDidRemove.event;

	constructor(container: HTMLElement) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, "div");
		this.element.className = "ash-notification-host";
		this.element.setAttribute("role", "region");
		this.element.setAttribute("aria-label", "Notifications");
		container.append(this.element);
		this._register(addDisposableListener(this.element, "click", event => {
			const target = event.target;
			const Element = document.defaultView?.Element;
			if (!Element || !(target instanceof Element)) return;
			const closeButton = target.closest<HTMLButtonElement>("[data-notification-close]");
			if (closeButton) this.remove(Number(closeButton.dataset.notificationClose));
		}));
		const removeElement = (): void => this.element.remove();
		this._register({ dispose: removeElement, [Symbol.dispose]: removeElement });
	}

	notify(options: NotificationOptions): NotificationHandle {
		this.assertNotDisposed();
		validateNotification(options);
		const item: NotificationItem = Object.freeze({
			...options,
			id: this.nextId++,
			createdAt: Date.now(),
			actions: Object.freeze([...(options.actions ?? [])]),
		});
		this.notifications.set(item.id, item);
		this._onDidAdd.fire(item);
		this.render();
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			this.remove(item.id);
		};
		return {
			item,
			close,
		};
	}

	info(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Info, message, actions });
	}

	warning(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Warning, message, actions });
	}

	error(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Error, message, actions });
	}

	getNotifications(): readonly NotificationItem[] {
		return [...this.notifications.values()];
	}

	remove(id: number): boolean {
		if (this.isDisposed) return false;
		const item = this.notifications.get(id);
		if (!item) return false;
		this.notifications.delete(id);
		this._onDidRemove.fire(item);
		this.render();
		return true;
	}

	clear(): void {
		for (const id of [...this.notifications.keys()]) this.remove(id);
	}

	protected override disposeCore(): void {
		this.notifications.clear();
		this.element.replaceChildren();
		super.disposeCore();
	}

	private render(): void {
		if (this.isDisposed) return;
		const document = this.element.ownerDocument;
		this.element.replaceChildren(...[...this.notifications.values()].map(item => {
			const notification = h(document, "article");
			notification.className = `ash-notification ash-notification-${item.severity}`;
			notification.setAttribute("role", item.severity === NotificationSeverity.Error ? "alert" : "status");
			const content = h(document, "div");
			content.className = "ash-notification-content";
			const message = h(document, "div");
			message.className = "ash-notification-message";
			message.textContent = item.message;
			content.append(message);
			if (item.source) {
				const source = h(document, "div");
				source.className = "ash-notification-source";
				source.textContent = item.source;
				content.append(source);
			}
			if (item.actions && item.actions.length > 0) {
				const actions = h(document, "div");
				actions.className = "ash-notification-actions";
				for (const action of item.actions) {
					const button = h(document, "button");
					button.type = "button";
					button.className = "ash-notification-action";
					button.textContent = action.label;
					button.addEventListener("click", () => {
						void Promise.resolve().then(() => action.run()).catch(error => console.error(`Notification action '${action.id}' failed`, error));
					});
					actions.append(button);
				}
				content.append(actions);
			}
			const close = h(document, "button");
			close.type = "button";
			close.className = "ash-notification-close";
			close.dataset.notificationClose = String(item.id);
			close.setAttribute("aria-label", "Close notification");
			close.textContent = "×";
			notification.append(content, close);
			return notification;
		}));
	}
}

function validateNotification(options: NotificationOptions): void {
	if (!Object.values(NotificationSeverity).includes(options.severity)) throw new TypeError("Unknown notification severity");
	if (typeof options.message !== "string" || options.message.trim().length === 0) throw new TypeError("Notification message must not be empty");
	const actionIds = new Set<string>();
	for (const action of options.actions ?? []) {
		if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(action.id)) throw new TypeError(`Invalid notification action ID: ${action.id}`);
		if (!actionIds.add(action.id)) throw new RangeError(`Duplicate notification action ID: ${action.id}`);
		if (typeof action.label !== "string" || action.label.trim().length === 0) throw new TypeError("Notification action label must not be empty");
		if (typeof action.run !== "function") throw new TypeError(`Notification action '${action.id}' must provide a callback`);
	}
}
