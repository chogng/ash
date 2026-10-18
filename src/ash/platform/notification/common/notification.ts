import { type Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

/** Severity used by user-visible notifications. */
export enum NotificationSeverity {
	Info = "info",
	Warning = "warning",
	Error = "error",
}

export enum NotificationPriority {
	DEFAULT,
	OPTIONAL,
	SILENT,
}

export interface INotificationSource {
	readonly id: string;
	readonly label: string;
}

export interface INotificationProgressProperties {
	readonly infinite?: boolean;
	readonly total?: number;
	readonly worked?: number;
}

export interface INotificationProgress {
	infinite(): void;
	total(value: number): void;
	worked(value: number): void;
	done(): void;
}

/** An action presented with a notification. */
export interface NotificationAction {
	readonly id: string;
	readonly label: string;
	run(): void | Promise<void>;
}

/** Primary actions are buttons; secondary actions appear in the notification menu. */
export interface INotificationActions {
	readonly primary?: readonly NotificationAction[];
	readonly secondary?: readonly NotificationAction[];
}

/** Input for one user-visible notification. */
export interface NotificationOptions {
	/** Called when a presentation creates a visible row. Consumers handle repeated presentation; history insertion is insufficient. */
	readonly onDidShow?: () => void;
	readonly severity: NotificationSeverity;
	readonly message: string;
	readonly source?: string;
	readonly priority?: NotificationPriority;
	readonly progress?: INotificationProgressProperties;
	readonly actions?: INotificationActions;
}

/** Immutable notification state published by the service. */
export interface NotificationItem extends NotificationOptions {
	readonly id: number;
	readonly createdAt: number;
	readonly onDidChange?: Event<NotificationItem>;
}

/** Handle used by the creator to close one notification. */
export interface NotificationHandle {
	readonly item: NotificationItem;
	readonly onDidClose: Event<void>;
	readonly progress: INotificationProgress;
	updateMessage(message: string): void;
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
