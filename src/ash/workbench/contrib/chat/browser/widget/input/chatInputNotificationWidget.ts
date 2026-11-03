import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../../../base/common/observable.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { ChatInputNoticeHost, ChatInputNoticeLane, type IChatInputNoticeFocusTarget } from './chatInputNoticeHost.js';
import { ChatInputNoticeVariant, ChatInputNoticeWidget } from './chatInputNoticeWidget.js';
import { ChatInputNotificationActionKind, ChatInputNotificationSeverity, IChatInputNotificationService, type IChatInputNotification, type IChatInputNotificationAction } from './chatInputNotificationService.js';
import './media/chatInputNotificationWidget.css';

export interface IChatInputNotificationDelegate {
	readonly container: HTMLElement;
	readonly noticeHost: ChatInputNoticeHost;
	readonly inputUri: URI;
	readonly hostVisible: IObservable<boolean>;
	readonly focusInput: () => void;
	readonly modelSelection: { readonly openPicker: () => void; };
}

/** Renders one service-selected notice, including its action and focus lifetimes. */
export class ChatInputNotificationWidget extends Disposable implements IChatInputNoticeFocusTarget {
	private readonly notice: ChatInputNoticeWidget;
	private readonly content = this._register(new DisposableStore());
	private readonly claim = this._register(new MutableDisposable());
	private current: IChatInputNotification | undefined;
	private hostVisible = false;
	private leading = false;
	private layout = '';
	private readonly message: HTMLElement;
	private readonly description: HTMLElement;
	private readonly actions: HTMLElement;
	private readonly actionError: HTMLElement;
	private readonly buttons: Button[] = [];
	private running = false;

	get domNode(): HTMLElement { return this.notice.domNode; }

	constructor(
		private readonly delegate: IChatInputNotificationDelegate,
		@IChatInputNotificationService private readonly notifications: IChatInputNotificationService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this.notice = this._register(new ChatInputNoticeWidget({
			container: delegate.container,
			variant: ChatInputNoticeVariant.Notification,
			onEscape: delegate.focusInput,
			focusInput: delegate.focusInput,
		}));
		this.notice.setVisible(false);
		const document = this.domNode.ownerDocument;
		this.message = h(document, 'p', { className: 'ash-chat-input-notification-message' });
		this.description = h(document, 'p');
		this.actions = h(document, 'div', { className: 'ash-chat-input-notification-actions' });
		this.actionError = h(document, 'p', { className: 'ash-chat-input-notification-action-error' });
		this.actionError.setAttribute('role', 'status');
		this.domNode.append(this.message, this.description, this.actions, this.actionError);
		this._register(notifications.onDidChange(() => this.render()));
		this._register(autorun(reader => {
			this.hostVisible = delegate.hostVisible.read(reader);
			this.render();
		}));
	}

	hasFocus(): boolean { return this.notice.hasFocus(); }
	focus(): void { this.notice.focus(); }
	canFocus(): boolean { return this.hostVisible && this.leading && !!this.current; }

	private render(): void {
		if (this.isDisposed) return;
		const notification = this.hostVisible ? this.notifications.getActiveNotification(item =>
			!item.inputUri || item.inputUri.toString() === this.delegate.inputUri.toString()) : undefined;
		if (!notification) {
			// Release while the old focus target still exists so arbitration can return focus.
			this.claim.clear();
			this.notice.setVisible(false);
			this.current = undefined;
			return;
		}
		const layout = JSON.stringify([notification.id, notification.dismissible, notification.actions]);
		const replaceActions = layout !== this.layout;
		const hadFocus = this.hasFocus();
		const previous = this.current;
		this.current = notification;
		if (this.message.textContent !== notification.message) this.message.textContent = notification.message;
		if (this.description.textContent !== (notification.description ?? '')) this.description.textContent = notification.description ?? '';
		if (this.description.hidden !== !notification.description) this.description.hidden = !notification.description;
		this.notice.setAriaLabel(notification.message);
		for (const [severity, name] of [[ChatInputNotificationSeverity.Info, 'info'], [ChatInputNotificationSeverity.Warning, 'warning'], [ChatInputNotificationSeverity.Error, 'error']] as const) {
			this.domNode.classList.toggle(`severity-${name}`, notification.severity === severity);
		}
		if (previous?.id !== notification.id) this.actionError.textContent = '';
		if (replaceActions) {
			this.content.clear();
			this.actions.replaceChildren();
			this.buttons.length = 0;
			this.layout = layout;
			for (const [index, action] of notification.actions.entries()) {
				this.buttons.push(this.content.add(new Button(this.actions, {
					...defaultButtonStyles, label: action.label, size: 'small', presentation: 'secondary',
					onClick: () => { void this.runAction(index); },
				})));
			}
			if (notification.dismissible) {
				this.buttons.push(this.content.add(new Button(this.actions, {
					...defaultButtonStyles,
					label: localize('chat.notice.dismiss', 'Dismiss notification'),
					size: 'small', presentation: 'quiet',
					onClick: () => {
						if (this.canFocus() && this.current) this.notifications.dismissNotification(this.current.id, this.current);
					},
				})));
			}
			if (hadFocus) this.focus();
		}
		for (const button of this.buttons) button.enabled = !this.running;
		if (!this.claim.value) {
			this.claim.value = this.delegate.noticeHost.occupy(ChatInputNoticeLane.Notification, {
				focusTarget: this,
				onDidChangeLeading: leading => {
					this.leading = leading;
					this.notice.setVisible(leading && this.hostVisible && !!this.current);
					if (leading) this.notifications.announceRendered(this.current);
				},
			});
		} else if (this.leading) {
			this.notifications.announceRendered(notification);
		}
	}

	private async runAction(index: number): Promise<void> {
		const notification = this.current;
		const action = notification?.actions[index];
		if (!notification || !action || !this.canFocus() || this.running || this.isDisposed) return;
		const document = this.domNode.ownerDocument;
		const focused = this.hasFocus() ? document.activeElement as HTMLElement : undefined;
		this.running = true;
		this.actionError.textContent = '';
		for (const button of this.buttons) button.enabled = false;
		try {
			await this.execute(action);
			if (!this.isDisposed) this.notifications.dismissNotification(notification.id, notification);
		} catch (error) {
			if (!this.isDisposed && this.current === notification && this.canFocus()) {
				this.actionError.textContent = localize('chat.notice.actionFailed', 'Could not complete the notification action: {0}', String(error));
			}
		} finally {
			this.running = false;
			if (!this.isDisposed) {
				for (const button of this.buttons) button.enabled = true;
				// Disabling an action can put focus on body. Restore it before the queued
				// dismissal releases the lane, without taking focus from an opened picker.
				if (focused && this.current === notification && this.canFocus() && document.activeElement === document.body) {
					if (focused.isConnected) focused.focus();
					else this.focus();
				}
			}
		}
	}

	private execute(action: IChatInputNotificationAction): Promise<unknown> | void {
		if (action.kind === ChatInputNotificationActionKind.OpenModelPicker) return this.delegate.modelSelection.openPicker();
		return this.commands.executeCommand(action.commandId, ...action.commandArgs ?? []);
	}

	protected override disposeCore(): void {
		this.claim.clear();
		super.disposeCore();
	}
}
