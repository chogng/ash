import { Emitter, Event } from '../../base/common/event.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import type {
	INotification,
	INotificationActions,
	INotificationHandle,
	INotificationProgressProperties,
	IStatusHandle,
	IStatusMessageOptions,
} from '../../platform/notification/common/notification.js';
import type { IConfigurationService } from '../../platform/configuration/common/configuration.js';

export const enum NotificationsSettings {
	NOTIFICATIONS_POSITION = 'workbench.notifications.position',
	NOTIFICATIONS_BUTTON = 'workbench.notifications.showInTitleBar',
}

export const enum NotificationsPosition {
	BOTTOM_RIGHT = 'bottom-right',
	BOTTOM_LEFT = 'bottom-left',
	TOP_RIGHT = 'top-right',
}

export function getNotificationsPosition(configurationService: IConfigurationService): NotificationsPosition {
	const position = configurationService.getValue<NotificationsPosition>(NotificationsSettings.NOTIFICATIONS_POSITION);
	return position === NotificationsPosition.BOTTOM_LEFT || position === NotificationsPosition.TOP_RIGHT
		? position
		: NotificationsPosition.BOTTOM_RIGHT;
}

export interface IStatusMessageViewItem {
	readonly message: string;
	readonly options?: IStatusMessageOptions;
}

/** Window history and presentation state stay in the Workbench, outside the producer contract. */
export interface NotificationItem extends Omit<INotification, 'message' | 'source'> {
	readonly id: number;
	readonly createdAt: number;
	readonly message: string;
	readonly source?: string;
	readonly sourceId?: string;
	readonly visible: boolean;
	/** Progress records keep their identity after completion and never deduplicate. */
	readonly hasProgress: boolean;
	readonly hasActiveProgress: boolean;
	readonly expanded: boolean;
	readonly canCollapse: boolean;
	readonly onDidChange: Event<NotificationItem>;
	updateVisibility(visible: boolean): void;
	expand(): void;
	collapse(): void;
	toggle(): void;
}

/** The notification history shared by every notification surface in one window. */
export class NotificationsModel extends Disposable {
	private readonly items = new Map<number, NotificationItem>();
	private readonly _onDidAdd = this._register(new Emitter<NotificationItem>());
	private readonly _onDidRemove = this._register(new Emitter<NotificationItem>());
	private readonly _onDidChange = this._register(new Emitter<NotificationItem>());
	private nextId = 1;
	private readonly closeCallbacks = new Map<number, (item: NotificationItem) => void>();

	readonly onDidAdd: Event<NotificationItem> = this._onDidAdd.event;
	readonly onDidRemove: Event<NotificationItem> = this._onDidRemove.event;
	private readonly statusChanges = this._register(new Emitter<void>());
	readonly onDidChangeStatusMessage = this.statusChanges.event;
	private currentStatusMessage: IStatusMessageViewItem | undefined;
	get statusMessage(): IStatusMessageViewItem | undefined {
		return this.currentStatusMessage;
	}

	showStatusMessage(message: string, options?: IStatusMessageOptions): IStatusHandle {
		this.assertNotDisposed();
		const item = (this.currentStatusMessage = { message, options: options ? { ...options } : undefined });
		this.statusChanges.fire();
		return {
			close: () => {
				if (this.currentStatusMessage !== item) {
					return;
				}
				this.currentStatusMessage = undefined;
				this.statusChanges.fire();
			},
		};
	}

	addNotification(options: INotification): INotificationHandle {
		this.assertNotDisposed();
		const id = this.nextId++;
		const resources = new DisposableStore();
		const closedEmitter = resources.add(new Emitter<void>());
		const visibilityEmitter = resources.add(new Emitter<boolean>());
		let closed = false;
		let closedItem: NotificationItem | undefined;
		const updateVisibility = (visible: boolean): void => {
			if (closed || this.items.get(id)?.visible === visible) return;
			this.update(id, { visible });
			visibilityEmitter.fire(visible);
		};
		const item: NotificationItem = Object.freeze({
			...options,
			id,
			message: options.message instanceof Error ? options.message.message : options.message,
			source: typeof options.source === 'string' ? options.source : options.source?.label,
			sourceId: typeof options.source === 'object' ? options.source.id : undefined,
			visible: false,
			progress: options.progress ? Object.freeze({ ...options.progress }) : undefined,
			hasProgress: options.progress !== undefined,
			hasActiveProgress: hasActiveProgress(options.progress),
			expanded: !!options.actions?.primary?.length,
			canCollapse: !options.actions?.primary?.length,
			expand: () => this.setExpanded(id, true),
			collapse: () => this.setExpanded(id, false),
			toggle: () => this.setExpanded(id, !this.items.get(id)?.expanded),
			updateVisibility,
			onDidChange: ((listener, thisArgs, disposables) =>
				this._onDidChange.event(
					current => {
						if (current.id === id) listener.call(thisArgs, current);
					},
					undefined,
					disposables,
				)) as Event<NotificationItem>,
			createdAt: Date.now(),
			actions: freezeActions(options.actions),
		});
		const model = this;
		const handle: INotificationHandle = {
			get visible() {
				return !closed && model.get(id)?.visible === true;
			},
			// A producer may receive its handle after a synchronous arrival listener removed it.
			// Replay that close on subscription so pending choices and clipboard reads can settle.
			onDidClose: (listener, thisArgs, disposables) => {
				if (closed) {
					listener.call(thisArgs, undefined);
					return Disposable.None;
				}
				return closedEmitter.event(listener, thisArgs, disposables);
			},
			onDidChangeVisibility: visibilityEmitter.event,
			updateSeverity: severity => this.update(id, { severity }),
			updateMessage: message =>
				this.update(id, { message: message instanceof Error ? message.message : message }),
			updateActions: actions => this.update(id, { actions: freezeActions(actions) }),
			progress: {
				infinite: () => this.update(id, { progress: { infinite: true } }),
				total: total => {
					const progress = this.get(id)?.progress;
					if (progress?.total === total && !progress.infinite) return;
					this.update(id, { progress: { total, worked: progress?.worked ?? 0 } });
				},
				worked: value => {
					const progress = this.get(id)?.progress;
					this.update(id, { progress: { total: progress?.total, worked: (progress?.worked ?? 0) + value } });
				},
				done: () => this.update(id, { progress: undefined }),
			},
			close: () => {
				// A producer's old handle must still dismiss a replacement of the same notification.
				const target = this.get(id) ?? closedItem;
				if (target) this.remove(this.findEquivalent(target)?.id ?? target.id);
			},
		};
		const close = (current: NotificationItem): void => {
			closed = true;
			closedItem = current;
			if (current.visible) visibilityEmitter.fire(false);
			closedEmitter.fire();
			resources.dispose();
		};
		this.closeCallbacks.set(id, close);
		const duplicate = this.findEquivalent(item);
		if (duplicate) this.remove(duplicate.id);
		// Closing the old record can synchronously dispose the window's model.
		if (this.isDisposed) {
			this.closeCallbacks.delete(id);
			close(item);
			return handle;
		}
		this.items.set(item.id, item);
		this._onDidAdd.fire(item);
		return handle;
	}

	getNotifications(): readonly NotificationItem[] {
		return [...this.items.values()];
	}
	get(id: number): NotificationItem | undefined {
		return this.items.get(id);
	}

	private setExpanded(id: number, expanded: boolean): void {
		const item = this.items.get(id);
		if (item?.canCollapse && item.expanded !== expanded) this.update(id, { expanded });
	}

	private findEquivalent(candidate: NotificationItem): NotificationItem | undefined {
		if (candidate.hasProgress) return undefined;
		return [...this.items.values()].find(item => {
			if (
				item.hasProgress ||
				item.source !== candidate.source ||
				item.sourceId !== candidate.sourceId ||
				item.message !== candidate.message
			)
				return false;
			const primary = item.actions?.primary ?? [];
			const other = candidate.actions?.primary ?? [];
			return (
				primary.length === other.length &&
				primary.every((action, index) => action.id === other[index].id && action.label === other[index].label)
			);
		});
	}

	private update(
		id: number,
		changes: Partial<
			Pick<NotificationItem, 'severity' | 'message' | 'actions' | 'progress' | 'visible' | 'expanded'>
		>,
	): void {
		const current = this.items.get(id);
		if (!current) return;
		const item = Object.freeze({
			...current,
			...changes,
			hasProgress: current.hasProgress || changes.progress !== undefined,
			hasActiveProgress: hasActiveProgress('progress' in changes ? changes.progress : current.progress),
			...('actions' in changes
				? { expanded: !!changes.actions?.primary?.length, canCollapse: !changes.actions?.primary?.length }
				: {}),
		});
		this.items.set(id, item);
		this._onDidChange.fire(item);
	}

	remove(id: number): boolean {
		const item = this.items.get(id);
		if (!item) return false;
		const close = this.closeCallbacks.get(id);
		this.closeCallbacks.delete(id);
		this.items.delete(id);
		close?.(item);
		this._onDidRemove.fire(item);
		return true;
	}

	clear(): void {
		for (const id of [...this.items.keys()]) this.remove(id);
	}

	protected override disposeCore(): void {
		this.clear();
		if (this.currentStatusMessage) {
			this.currentStatusMessage = undefined;
			this.statusChanges.fire();
		}
		super.disposeCore();
	}
}

function hasActiveProgress(progress: INotificationProgressProperties | undefined): boolean {
	return progress?.infinite === true || progress?.total !== undefined || progress?.worked !== undefined;
}

function freezeActions(actions: INotificationActions | undefined): INotificationActions {
	return Object.freeze({
		primary: Object.freeze([...(actions?.primary ?? [])]),
		secondary: Object.freeze([...(actions?.secondary ?? [])]),
	});
}
