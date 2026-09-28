import { Emitter, type Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type { NotificationItem, NotificationOptions } from "../../platform/notification/common/notification.js";

/** The notification history shared by every notification surface in one window. */
export class NotificationsModel extends Disposable {
	private readonly items = new Map<number, NotificationItem>();
	private readonly _onDidAdd = this._register(new Emitter<NotificationItem>());
	private readonly _onDidRemove = this._register(new Emitter<NotificationItem>());
	private nextId = 1;

	readonly onDidAdd: Event<NotificationItem> = this._onDidAdd.event;
	readonly onDidRemove: Event<NotificationItem> = this._onDidRemove.event;

	add(options: NotificationOptions): NotificationItem {
		const item: NotificationItem = Object.freeze({ ...options, id: this.nextId++, createdAt: Date.now(), actions: Object.freeze([...(options.actions ?? [])]) });
		this.items.set(item.id, item);
		this._onDidAdd.fire(item);
		return item;
	}

	getNotifications(): readonly NotificationItem[] { return [...this.items.values()]; }

	remove(id: number): boolean {
		const item = this.items.get(id);
		if (!item) return false;
		this.items.delete(id);
		this._onDidRemove.fire(item);
		return true;
	}

	clear(): void {
		for (const id of [...this.items.keys()]) this.remove(id);
	}

	protected override disposeCore(): void {
		this.items.clear();
		super.disposeCore();
	}
}
