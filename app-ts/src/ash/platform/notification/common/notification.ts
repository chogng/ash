import { type Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Severity used by user-visible notifications. */
export enum NotificationSeverity {
	Info = "info",
	Warning = "warning",
	Error = "error",
}

/** An action presented with a notification. */
export interface NotificationAction {
	readonly id: string;
	readonly label: string;
	run(): void | Promise<void>;
}

/** Input for one user-visible notification. */
export interface NotificationOptions {
	readonly severity: NotificationSeverity;
	readonly message: string;
	readonly source?: string;
	readonly actions?: readonly NotificationAction[];
}

/** Immutable notification state published by the service. */
export interface NotificationItem extends NotificationOptions {
	readonly id: number;
	readonly createdAt: number;
}

/** Handle used by the creator to close one notification. */
export interface NotificationHandle {
	readonly item: NotificationItem;
	close(): void;
}

/** Window-scoped notification service. */
export interface INotificationService {
	readonly onDidAdd: Event<NotificationItem>;
	readonly onDidRemove: Event<NotificationItem>;

	notify(options: NotificationOptions): NotificationHandle;
	info(message: string, actions?: readonly NotificationAction[]): NotificationHandle;
	warning(message: string, actions?: readonly NotificationAction[]): NotificationHandle;
	error(message: string, actions?: readonly NotificationAction[]): NotificationHandle;

	getNotifications(): readonly NotificationItem[];
	remove(id: number): boolean;
	clear(): void;
}

export const INotificationService = createServiceIdentifier<INotificationService>("notificationService");
