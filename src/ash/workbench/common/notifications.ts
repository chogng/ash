import { Emitter, Event } from "../../base/common/event.js";
import { Disposable } from "../../base/common/lifecycle.js";
import type { NotificationItem, NotificationOptions } from "../../platform/notification/common/notification.js";

/** The notification history shared by every notification surface in one window. */
export class NotificationsModel extends Disposable {
	private readonly items = new Map<number, NotificationItem>();
	private readonly _onDidAdd = this._register(new Emitter<NotificationItem>());
	private readonly _onDidRemove = this._register(new Emitter<NotificationItem>());
	private readonly _onDidChange = this._register(new Emitter<NotificationItem>());
	private nextId = 1;

	readonly onDidAdd: Event<NotificationItem> = this._onDidAdd.event;
	readonly onDidRemove: Event<NotificationItem> = this._onDidRemove.event;

	add(options: NotificationOptions): NotificationItem {
		const id = this.nextId++;
		const item: NotificationItem = Object.freeze({
			...options,
			id,
			onDidChange: ((listener, thisArgs, disposables) => this._onDidChange.event(current => {
				if (current.id === id) listener.call(thisArgs, current);
			}, undefined, disposables)) as Event<NotificationItem>,
			createdAt: Date.now(),
			actions: Object.freeze({
				primary: Object.freeze([...(options.actions?.primary ?? [])]),
				secondary: Object.freeze([...(options.actions?.secondary ?? [])]),
			}),
		});
		this.items.set(item.id, item);
		this._onDidAdd.fire(item);
		return item;
	}

	getNotifications(): readonly NotificationItem[] { return [...this.items.values()]; }
	get(id: number): NotificationItem | undefined { return this.items.get(id); }

	update(id: number, changes: Partial<Pick<NotificationOptions, 'message' | 'progress'>>): void {
		const current = this.items.get(id);
		if (!current) return;
		const item = Object.freeze({ ...current, ...changes });
		this.items.set(id, item);
		this._onDidChange.fire(item);
	}

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
		this.clear();
		super.disposeCore();
	}
}
