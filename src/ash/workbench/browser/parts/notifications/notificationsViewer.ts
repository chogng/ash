import { defaultButtonStyles, defaultProgressBarStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/notificationsList.css';
import '../../../../base/browser/ui/progressbar/progressbar.css';
import './media/notificationsActions.css';
import { h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Separator, type IAction, type IActionRunner } from '../../../../base/common/actions.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService, NotificationsFilter, Severity } from '../../../../platform/notification/common/notification.js';
import type { NotificationItem } from '../../../common/notifications.js';
import { ConfigureNotificationAction } from './notificationsActions.js';

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
		@INotificationService notificationService: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'article');
		this.domNode.className = presentation === 'toast' ? `ash-notification ash-notification-${Severity[item.severity].toLowerCase()}` : 'ash-notifications-row';
		this.domNode.dataset.notificationId = String(item.id);
		this.domNode.dataset.severity = Severity[item.severity].toLowerCase();
		// The shared alert owner announces once, including arrivals while toasts are hidden.
		this.domNode.setAttribute('role', presentation === 'center' ? 'listitem' : 'article');
		this.domNode.tabIndex = 0;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const severity = h(container.ownerDocument, 'span');
		severity.className = `ash-notification-severity ash-notification-severity-${Severity[item.severity].toLowerCase()}`;
		severity.setAttribute('role', 'img');
		const severityLabels: Partial<Record<Severity, string>> = {
			[Severity.Info]: localize('notifications.info', 'Information'),
			[Severity.Warning]: localize('notifications.warning', 'Warning'),
			[Severity.Error]: localize('notifications.error', 'Error'),
		};
		severity.setAttribute('aria-label', severityLabels[item.severity] ?? '');
		appendIcon(item.severity === Severity.Error ? Lxicon.error : item.severity === Severity.Warning ? Lxicon.warning : Lxicon.info, severity);
		this.domNode.append(severity);
		const content = h(container.ownerDocument, 'div');
		content.className = 'ash-notification-content';
		const message = h(container.ownerDocument, 'div');
		message.className = 'ash-notification-message';
		message.textContent = item.message;
		content.append(message);
		const progress = this._register(new ProgressBar(content, defaultProgressBarStyles));

		const details = h(container.ownerDocument, 'div');
		details.className = 'ash-notification-details';
		if (item.source) {
			const source = h(container.ownerDocument, 'div');
			source.className = 'ash-notification-source';
			source.textContent = localize('notifications.source', 'Source: {0}', item.source);
			details.append(source);
		}

		this.domNode.append(content);
		const toolbarContainer = h(container.ownerDocument, 'div');
		toolbarContainer.className = 'ash-notification-toolbar';
		this.domNode.append(toolbarContainer);
		const label = localize('notifications.remove', 'Remove notification');
		const close: IAction = { id: 'notification.clear', label, tooltip: label, enabled: true, icon: Lxicon.close, run: () => remove(item.id) };
		const toolbar = this._register(new WorkbenchToolBar(toolbarContainer, contextMenuService, {
			ariaLabel: label,
			actionViewItemProvider: (action, options) => {
				if (action === close) return new NotificationCloseActionViewItem(action, item.id, presentation);
				if (action instanceof ConfigureNotificationAction) return new DropdownMenuActionViewItem(action, () => {
					const actions: IAction[] = [];
					if (item.sourceId && item.source) {
						const source = { id: item.sourceId, label: item.source };
						const muted = notificationService.getFilter(source) === NotificationsFilter.ERROR;
						const label = muted ? localize('notifications.source.enable', "Turn On All Notifications from '{0}'", source.label) : localize('notifications.source.disable', "Turn Off Info and Warning Notifications from '{0}'", source.label);
						actions.push({ id: 'notification.toggleSource', label, tooltip: label, enabled: true, run: () => notificationService.setFilter({ ...source, filter: muted ? NotificationsFilter.OFF : NotificationsFilter.ERROR }) });
					}
					if (actions.length && secondaryActions.length) actions.push(new Separator());
					return [...actions, ...secondaryActions];
				}, contextMenuService, options);
				return undefined;
			},
		}));
		const primaryResources = this._register(new DisposableStore());
		let primaryContainer: HTMLElement | undefined;
		let previousActions: NotificationItem['actions'];
		let previousProgress: boolean | undefined;
		let secondaryActions: IAction[] = [];
		// Read the contract explicitly: actions may expose getters on their prototype.
		// Buttons invoke the producer's method with its receiver and no synthetic context.
		const runnableAction = (action: IAction): IAction => ({
			id: action.id, label: action.label, tooltip: action.tooltip,
			enabled: action.enabled, checked: action.checked, icon: action.icon,
			run: () => action.run(),
		});
		const update = (current: NotificationItem): void => {
			const severityName = Severity[current.severity].toLowerCase();
			this.domNode.dataset.severity = severityName;
			if (presentation === 'toast') this.domNode.className = `ash-notification ash-notification-${severityName}`;
			severity.className = `ash-notification-severity ash-notification-severity-${severityName}`;
			severity.setAttribute('aria-label', severityLabels[current.severity] ?? '');
			severity.replaceChildren();
			appendIcon(current.severity === Severity.Error ? Lxicon.error : current.severity === Severity.Warning ? Lxicon.warning : Lxicon.info, severity);
			message.textContent = current.message;
			progress.element.hidden = !current.hasActiveProgress;
			progress.element.setAttribute('aria-label', current.message);
			progress.value = current.progress?.total ? (current.progress.worked ?? 0) / current.progress.total : undefined;
			const hasProgress = current.hasActiveProgress;
			if (previousActions !== current.actions || previousProgress !== hasProgress) {
				previousProgress = hasProgress;
				secondaryActions = current.actions?.secondary?.map(action => {
					const runnable = runnableAction(action);
					return { ...runnable, run: () => actionRunner.run(runnable) };
				}) ?? [];
				const actions: IAction[] = [];
				if (current.sourceId || secondaryActions.length) actions.push(new ConfigureNotificationAction(secondaryActions));
				if (!hasProgress) actions.push(close);
				toolbar.setActions(actions);
			}
			if (current.actions === previousActions) return;
			previousActions = current.actions;
			primaryResources.clear();
			primaryContainer?.remove();
			primaryContainer = undefined;
			if (current.actions?.primary?.length) {
				primaryContainer = h(container.ownerDocument, 'div');
				primaryContainer.className = 'ash-notification-actions';
				for (const [index, action] of current.actions.primary.entries()) {
					const runnable = runnableAction(action);
					const button = primaryResources.add(new Button(primaryContainer, {
						...defaultButtonStyles,
						label: action.label,
						title: action.tooltip || action.label,
						presentation: index === 0 ? 'primary' : 'secondary',
						onClick: () => { void Promise.resolve().then(() => actionRunner.run(runnable)); },
					}));
					button.enabled = action.enabled;
					button.domNode.classList.add('ash-notification-action');
				}
				details.append(primaryContainer);
			}
			if (details.childElementCount) content.append(details);
			else details.remove();
		};
		update(item);
		this._register(item.onDidChange(update));
	}
}

/** Keeps notification identity on the control owned by the action view item. */
class NotificationCloseActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, private readonly id: number, private readonly presentation: 'toast' | 'center') {
		super(action, { buttonStyles: defaultButtonStyles });
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
