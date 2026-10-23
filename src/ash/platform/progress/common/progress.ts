import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { INotificationSource, NotificationPriority } from "../../notification/common/notification.js";

export const enum ProgressLocation {
	Explorer = 1,
	Scm = 3,
	Extensions = 5,
	Window = 10,
	Notification = 15,
}

/** Common options for the progress locations consumed by this Workbench. */
export interface IProgressOptions {
	readonly location: ProgressLocation | string;
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

export interface IProgressCompositeOptions extends IProgressOptions {
	readonly location: ProgressLocation.Explorer | ProgressLocation.Scm | ProgressLocation.Extensions | string;
	readonly delay?: number;
}

export interface IProgressStep {
	message?: string;
	increment?: number;
	total?: number;
}

export interface IProgress<T> {
	report(item: T): void;
}

/** Presentation scoped to a view; producers retain ownership of their work. */
export interface IProgressIndicator {
	show(infinite: true, delay?: number): IProgressRunner;
	show(total: number, delay?: number): IProgressRunner;
	showWhile(promise: Promise<unknown>, delay?: number): Promise<void>;
}

export interface IProgressRunner {
	total(value: number): void;
	worked(value: number): void;
	done(): void;
}

/** Presentation follows the producer's Promise; cancellation requests do not settle it. */
export interface IProgressService {
	withProgress<R>(
		options: IProgressOptions | IProgressWindowOptions | IProgressNotificationOptions | IProgressCompositeOptions,
		task: (progress: IProgress<IProgressStep>) => Promise<R>,
		onDidCancel?: (choice?: number) => void,
	): Promise<R>;
}

export const IProgressService = createServiceIdentifier<IProgressService>("progressService");
