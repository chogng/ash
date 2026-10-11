import './media/notificationsList.css';
import './media/notificationsActions.css';
import { h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import type { IAction, IActionRunner } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { NotificationItem } from '../../../../platform/notification/common/notification.js';

/** Renders one immutable record for either notification surface. */
export class NotificationTemplateRenderer extends Disposable {
	public readonly domNode: HTMLElement;

	constructor(
		container: HTMLElement,
		item: NotificationItem,
		presentation: 'toast' | 'center',
		actionRunner: IActionRunner,
		remove: (id: number) => void,
		@IContextMenuService contextMenuService: IContextMenuService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'article');
		this.domNode.className = presentation === 'toast' ? `ash-notification ash-notification-${item.severity}` : 'ash-notifications-row';
		this.domNode.dataset.notificationId = String(item.id);
		// The shared alert owner announces once, including arrivals while toasts are hidden.
		this.domNode.setAttribute('role', presentation === 'center' ? 'listitem' : 'article');
		if (presentation === 'center') {
			this.domNode.tabIndex = 0;
		}
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const content = h(container.ownerDocument, 'div');
		content.className = 'ash-notification-content';
		const message = h(container.ownerDocument, 'div');
		message.className = 'ash-notification-message';
		message.textContent = item.message;
		content.append(message);
		if (item.source) {
			const source = h(container.ownerDocument, 'div');
			source.className = 'ash-notification-source';
			source.textContent = item.source;
			content.append(source);
		}
		if (item.actions?.length) {
			const actions = h(container.ownerDocument, 'div');
			actions.className = 'ash-notification-actions';
			for (const action of item.actions) {
				const notificationAction: IAction = { id: action.id, label: action.label, tooltip: '', enabled: true, run: () => action.run() };
				const button = this._register(new Button(actions, {
					label: action.label,
					title: action.label,
					presentation: 'secondary',
					onClick: () => { void Promise.resolve().then(() => actionRunner.run(notificationAction)); },
				}));
				button.domNode.classList.add('ash-notification-action');
			}
			content.append(actions);
		}
		this.domNode.append(content);
		const toolbarContainer = h(container.ownerDocument, 'div');
		toolbarContainer.className = 'ash-notification-toolbar';
		this.domNode.append(toolbarContainer);
		const label = localize('notifications.remove', 'Remove notification');
		const close: IAction = { id: 'notification.clear', label, tooltip: label, enabled: true, icon: Lxicon.close, run: () => remove(item.id) };
		const toolbar = this._register(new WorkbenchToolBar(toolbarContainer, contextMenuService, {
			ariaLabel: label,
			actionViewItemProvider: action => new NotificationCloseActionViewItem(action, item.id, presentation),
		}));
		toolbar.setActions([close]);
	}
}

/** Keeps notification identity on the control owned by the action view item. */
class NotificationCloseActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly id: number, private readonly presentation: 'toast' | 'center') {
		super(action);
	}

	public override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.classList.add(this.presentation === 'toast' ? 'ash-notification-close' : 'ash-notifications-remove');
		if (this.presentation === 'toast') {
			this.button.domNode.dataset.notificationClose = String(this.id);
		} else {
			this.button.domNode.dataset.notificationRemove = String(this.id);
		}
	}
}
