import './media/notifications.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { NotificationSeverity, type NotificationItem } from '../../../../platform/notification/common/notification.js';
import type { NotificationActionRunner } from './notificationsCommands.js';

/** Owns one immutable record's DOM and controls in either notification surface. */
export class NotificationRenderer extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(document: Document, item: NotificationItem, presentation: 'toast' | 'center', runner: NotificationActionRunner) {
		super();
		this.domNode = h(document, 'article');
		this._register(toDisposable(() => this.domNode.remove()));
		this.domNode.className = `${presentation === 'toast' ? 'ash-notification' : 'ash-notifications-row'} ash-notification-${item.severity}`;
		this.domNode.dataset.notificationId = String(item.id);
		if (presentation === 'center') {
			this.domNode.setAttribute('role', 'listitem');
			this.domNode.tabIndex = 0;
		} else {
			this.domNode.setAttribute('role', item.severity === NotificationSeverity.Error ? 'alert' : 'status');
		}
		let severityLabel = localize('notifications.info', 'Information');
		let icon = Lxicon.info;
		if (item.severity === NotificationSeverity.Error) {
			severityLabel = localize('notifications.error', 'Error');
			icon = Lxicon.error;
		} else if (item.severity === NotificationSeverity.Warning) {
			severityLabel = localize('notifications.warning', 'Warning');
			icon = Lxicon.warning;
		}
		this.domNode.setAttribute('aria-label', localize('notifications.messageLabel', '{0}: {1}', severityLabel, item.message));
		const severity = h(document, 'span', { className: 'ash-notification-severity' });
		appendIcon(icon, severity);
		severity.setAttribute('aria-hidden', 'true');
		const content = h(document, 'div', { className: 'ash-notification-content' });
		const message = h(document, 'div', { className: 'ash-notification-message' });
		message.textContent = item.message;
		content.append(message);
		if (item.source) {
			const source = h(document, 'div', { className: 'ash-notification-source' });
			source.textContent = item.source;
			content.append(source);
		}
		if (item.actions?.length) {
			const actions = h(document, 'div', { className: 'ash-notification-actions' });
			for (const [index, action] of item.actions.entries()) {
				const button = this._register(new Button(actions, { label: action.label, title: action.label, presentation: index === 0 ? 'primary' : 'secondary', size: 'small' }));
				button.domNode.classList.add('ash-notification-action');
				this._register(button.onDidClick(() => {
					void Promise.resolve().then(async () => {
						if (this.isDisposed || !this.domNode.isConnected || this.domNode.closest('[hidden], [inert]')) {
							return;
						}
						await runner.runNotificationAction(action);
					});
				}));
			}
			content.append(actions);
		}
		this.domNode.append(severity, content);
		const close = this._register(new Button(this.domNode, { label: localize('notifications.remove', 'Remove notification'), icon: Lxicon.close, iconOnly: true, presentation: 'quiet', size: 'small' }));
		close.domNode.classList.add(presentation === 'toast' ? 'ash-notification-close' : 'ash-notifications-remove');
		if (presentation === 'toast') {
			close.domNode.dataset.notificationClose = String(item.id);
		} else {
			close.domNode.dataset.notificationRemove = String(item.id);
		}
	}
}
