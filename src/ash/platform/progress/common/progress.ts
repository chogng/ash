import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { INotificationSource, NotificationPriority } from "../../notification/common/notification.js";

export const enum ProgressLocation {
	Window = 10,
	Notification = 15,
}

/** Common options for the progress locations consumed by this Workbench. */
export interface IProgressOptions {
	readonly location: ProgressLocation;
	readonly title?: string;
	readonly source?: string | INotificationSource;
	readonly total?: number;
	readonly cancellable?: boolean | string;
}

export interface IProgressWindowOptions extends IProgressOptions {
	readonly location: ProgressLocation.Window;
	readonly command?: string;
	readonly type?: 'loading' | 'syncing';
}

export interface IProgressNotificationOptions extends IProgressOptions {
	readonly location: ProgressLocation.Notification;
	readonly delay?: number;
	readonly priority?: NotificationPriority;
	readonly type?: 'loading' | 'syncing';
}

export interface IProgressStep {
	message?: string;
	increment?: number;
	total?: number;
}

export interface IProgress<T> {
	report(item: T): void;
}

/** Presentation follows the producer's Promise; cancellation requests do not settle it. */
export interface IProgressService {
	withProgress<R>(
		options: IProgressOptions | IProgressWindowOptions | IProgressNotificationOptions,
		task: (progress: IProgress<IProgressStep>) => Promise<R>,
		onDidCancel?: (choice?: number) => void,
	): Promise<R>;
}

export const IProgressService = createServiceIdentifier<IProgressService>("progressService");
