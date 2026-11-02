import { alert, status } from '../../../../../../../base/browser/ui/aria/aria.js';
import { Emitter, type Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../../platform/instantiation/common/instantiation.js';

export const enum ChatInputNotificationSeverity {
	Info = 0,
	Warning = 1,
	Error = 2,
}

export const enum ChatInputNotificationActionKind {
	Command = 'command',
	OpenModelPicker = 'openModelPicker',
}

export type IChatInputNotificationAction = {
	readonly label: string;
} & ({ readonly kind: ChatInputNotificationActionKind.Command; readonly commandId: string; readonly commandArgs?: readonly unknown[]; }
	| { readonly kind: ChatInputNotificationActionKind.OpenModelPicker; });

export interface IChatInputNotification {
	readonly id: string;
	/** A composer instance, independently of the conversation it currently displays. */
	readonly inputUri?: URI;
	readonly severity: ChatInputNotificationSeverity;
	readonly message: string;
	readonly description?: string;
	readonly actions: readonly IChatInputNotificationAction[];
	readonly dismissible: boolean;
	readonly autoDismissOnMessage: boolean;
}

export interface IChatInputNotificationSetOptions {
	/** Preserve dismissal and ordering when projecting another snapshot of the same notice. */
	readonly inPlace?: boolean;
}

export interface IChatInputNotificationContext {
	readonly inputUri?: URI;
}

export const IChatInputNotificationService = createDecorator<IChatInputNotificationService>('chatInputNotificationService');

export interface IChatInputNotificationService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	setNotification(notification: IChatInputNotification, options?: IChatInputNotificationSetOptions): void;
	deleteNotification(id: string): void;
	dismissNotification(id: string, notification?: IChatInputNotification): void;
	getActiveNotification(filter?: (notification: IChatInputNotification) => boolean): IChatInputNotification | undefined;
	handleMessageSent(context?: IChatInputNotificationContext): void;
	announceRendered(notification: IChatInputNotification | undefined): void;
}

interface NotificationEntry {
	notification: IChatInputNotification;
	dismissed: boolean;
	order: number;
	announcement?: string;
}

/** Window-owned presentation state. Model and execution failures remain owned by their producers. */
export class ChatInputNotificationService extends Disposable implements IChatInputNotificationService {
	readonly _serviceBrand = undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly entries = new Map<string, NotificationEntry>();
	private order = 0;
	private changePending = false;

	setNotification(notification: IChatInputNotification, options?: IChatInputNotificationSetOptions): void {
		const previous = this.entries.get(notification.id);
		const preserve = !!previous && options?.inPlace === true;
		this.entries.set(notification.id, {
			notification,
			dismissed: preserve && previous.dismissed,
			order: preserve ? previous.order : ++this.order,
			announcement: preserve ? previous.announcement : undefined,
		});
		this.scheduleChange();
	}

	deleteNotification(id: string): void {
		if (this.entries.delete(id)) this.scheduleChange();
	}

	dismissNotification(id: string, notification?: IChatInputNotification): void {
		const entry = this.entries.get(id);
		// An asynchronous action acknowledges the notice it displayed, never a later replacement.
		if (!entry || entry.dismissed || (notification && entry.notification !== notification)) return;
		entry.dismissed = true;
		this.scheduleChange();
	}

	getActiveNotification(filter?: (notification: IChatInputNotification) => boolean): IChatInputNotification | undefined {
		let active: NotificationEntry | undefined;
		for (const entry of this.entries.values()) {
			if (entry.dismissed || (filter && !filter(entry.notification))) continue;
			if (!active || entry.notification.severity > active.notification.severity
				|| (entry.notification.severity === active.notification.severity && entry.order > active.order)) {
				active = entry;
			}
		}
		return active?.notification;
	}

	handleMessageSent(context?: IChatInputNotificationContext): void {
		let changed = false;
		for (const entry of this.entries.values()) {
			const notification = entry.notification;
			if (!entry.dismissed && notification.autoDismissOnMessage
				&& (!context || !notification.inputUri || notification.inputUri.toString() === context.inputUri?.toString())) {
				entry.dismissed = true;
				changed = true;
			}
		}
		if (changed) this.scheduleChange();
	}

	announceRendered(notification: IChatInputNotification | undefined): void {
		if (!notification) return;
		const entry = this.entries.get(notification.id);
		if (!entry || entry.notification !== notification || entry.dismissed) return;
		const signature = JSON.stringify([notification.severity, notification.message, notification.description]);
		if (entry.announcement === signature) return;
		entry.announcement = signature;
		const text = [notification.message, notification.description].filter(Boolean).join('\n');
		if (notification.severity === ChatInputNotificationSeverity.Error) alert(text);
		else status(text);
	}

	/** A model render can replace several notices; only its final selection may expose an introduction. */
	private scheduleChange(): void {
		if (this.changePending || this.isDisposed) return;
		this.changePending = true;
		queueMicrotask(() => {
			this.changePending = false;
			if (!this.isDisposed) this.changed.fire();
		});
	}

	protected override disposeCore(): void {
		this.entries.clear();
		super.disposeCore();
	}
}
