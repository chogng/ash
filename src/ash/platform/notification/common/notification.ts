import { type Event } from "../../../base/common/event.js";
import type { IAction } from "../../../base/common/actions.js";
import Severity from "../../../base/common/severity.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export { Severity };

export type NotificationMessage = string | Error;

export enum NotificationPriority {
	DEFAULT,
	OPTIONAL,
	SILENT,
	/** Urgent notifications remain visible while do not disturb is enabled. */
	URGENT,
}

/** Do not disturb keeps errors visible and delivers other notifications silently. */
export enum NotificationsFilter {
	OFF = 0,
	ERROR = 1,
}

export interface INotificationSource {
	readonly id: string;
	readonly label: string;
}

export interface INotificationSourceFilter extends INotificationSource {
	readonly filter: NotificationsFilter;
}

export interface IStatusMessageOptions {
	readonly showAfter?: number;
	readonly hideAfter?: number;
}

export interface IStatusHandle {
	close(): void;
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

/** Primary actions are buttons; secondary actions appear in the notification menu. */
export interface INotificationActions {
	readonly primary?: readonly IAction[];
	readonly secondary?: readonly IAction[];
}

/** Input for one user-visible notification. */
export interface INotification {
	readonly severity: Severity;
	readonly message: NotificationMessage;
	readonly source?: string | INotificationSource;
	readonly priority?: NotificationPriority;
	readonly progress?: INotificationProgressProperties;
	/** Keeps the toast visible until explicitly dismissed. */
	readonly sticky?: boolean;
	readonly actions?: INotificationActions;
}

/** Handle used by the creator to close one notification. */
export interface INotificationHandle {
	readonly visible?: boolean;
	readonly onDidClose: Event<void>;
	readonly onDidChangeVisibility: Event<boolean>;
	readonly progress: INotificationProgress;
	updateSeverity(severity: Severity): void;
	updateMessage(message: NotificationMessage): void;
	updateActions(actions?: INotificationActions): void;
	close(): void;
}

/** Window-scoped notification service. */
export interface INotificationService {
	readonly onDidChangeFilter: Event<void>;
	setFilter(filter: NotificationsFilter | INotificationSourceFilter): void;
	getFilter(source?: INotificationSource): NotificationsFilter;
	getFilters(): INotificationSourceFilter[];
	removeFilter(sourceId: string): void;
	notify(options: INotification): INotificationHandle;
	info(message: NotificationMessage | NotificationMessage[]): void;
	warn(message: NotificationMessage | NotificationMessage[]): void;
	error(message: NotificationMessage | NotificationMessage[]): void;
	status(message: NotificationMessage, options?: IStatusMessageOptions): IStatusHandle;
}

export const INotificationService = createServiceIdentifier<INotificationService>("notificationService");
