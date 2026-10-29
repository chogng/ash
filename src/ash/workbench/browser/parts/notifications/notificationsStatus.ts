import { getNotificationsPosition, NotificationsPosition, NotificationsSettings, type NotificationsModel, type NotificationItem } from '../../../common/notifications.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { INotificationService, NotificationsFilter } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor, type IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';

/** Owns notification history and status messages in the window's status bar. */
export class NotificationsStatus extends Disposable {
	private readonly bell = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly statusMessage = this._register(new MutableDisposable());
	private readonly itemChanges = this._register(new DisposableMap<number>());
	private alignment: StatusbarAlignment | undefined;
	private centerVisible = false;
	private toastsVisible = false;
	private readonly unread = new Set<number>();

	constructor(private readonly model: NotificationsModel, private readonly statusbar: IStatusbarService | undefined, private readonly toggle: () => void, @INotificationService private readonly notificationService: INotificationService, @IConfigurationService private readonly configurationService: IConfigurationService) {
		super();
		this._register(model.onDidAdd(item => {
			this.observe(item);
			if (!this.centerVisible) { this.unread.add(item.id); }
			this.render();
		}));
		this._register(model.onDidRemove(item => {
			this.itemChanges.deleteAndDispose(item.id);
			this.unread.delete(item.id);
			this.render();
		}));
		this._register(notificationService.onDidChangeFilter(() => this.render()));
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(NotificationsSettings.NOTIFICATIONS_POSITION)) this.render();
		}));
		this._register(model.onDidChangeStatusMessage(() => this.renderStatusMessage()));
		for (const item of model.getNotifications()) this.observe(item);
		this.renderStatusMessage();
		this.render();
	}

	private observe(item: NotificationItem): void { this.itemChanges.set(item.id, item.onDidChange(() => this.render())); }

	public update(isCenterVisible: boolean, isToastsVisible: boolean): void {
		this.centerVisible = isCenterVisible;
		this.toastsVisible = isToastsVisible;
		if (isCenterVisible) { this.unread.clear(); }
		this.render();
	}

	private entry(): IStatusbarEntry {
		const muted = this.notificationService.getFilter() === NotificationsFilter.ERROR;
		const running = this.centerVisible || this.toastsVisible ? 0 : this.model.getNotifications().filter(item => item.hasActiveProgress).length;
		const attention = this.unread.size > 0 || running > 0;
		let icon = attention ? Lxicon.bellDot : Lxicon.bell;
		let label: string;
		if (this.centerVisible) {
			label = localize('notifications.hideCenter', 'Hide Notification Center');
		} else if (this.model.getNotifications().length === 0) {
			label = localize('notifications.empty', 'No notifications');
		} else if (this.unread.size === 0) {
			label = localize('notifications.noNew', 'No New Notifications');
		} else if (this.unread.size === 1) {
			label = localize('notifications.oneNew', '1 New Notification');
		} else {
			label = localize('notifications.newCount', '{0} New Notifications', this.unread.size);
		}
		if (running > 0) { label = localize('notifications.inProgress', '{0} ({1} in progress)', label, running); }
		if (muted) {
			icon = attention ? Lxicon.bellSlashDot : Lxicon.bellSlash;
			label = localize('notifications.doNotDisturbStatus', 'Do Not Disturb Mode is Enabled. {0}', label);
		}
		const action = this.centerVisible ? localize('notifications.hideCenter', 'Hide Notification Center') : localize('notifications.showCenter', 'Show Notification Center');
		return { showInAllWindows: true, icon, text: '', ariaLabel: this.centerVisible ? label : `${action}. ${label}`, tooltip: label, run: this.toggle };
	}

	private render(): void {
		const position = getNotificationsPosition(this.configurationService);
		if (position === NotificationsPosition.TOP_RIGHT) {
			this.bell.clear();
			this.alignment = undefined;
		} else if (this.statusbar) {
			const alignment = position === NotificationsPosition.BOTTOM_LEFT ? StatusbarAlignment.Left : StatusbarAlignment.Right;
			if (this.alignment !== alignment) { this.bell.clear(); this.alignment = alignment; }
			if (this.bell.value) this.bell.value.update(this.entry());
			else this.bell.value = this.statusbar.addEntry(this.entry(), { id: 'ash.status.notifications', alignment, priority: Number.MAX_SAFE_INTEGER });
		}
	}

	private renderStatusMessage(): void {
		this.statusMessage.clear();
		const item = this.model.statusMessage;
		if (!item || !this.statusbar) { return; }
		let entry: IStatusbarEntryAccessor | undefined;
		const show = setTimeout(() => {
			entry = this.statusbar!.addEntry({ text: item.message, ariaLabel: item.message }, { id: 'status.message', alignment: StatusbarAlignment.Left, priority: -Number.MAX_SAFE_INTEGER });
		}, item.options?.showAfter ?? 0);
		const hideAfter = item.options?.hideAfter ?? 0;
		const hide = hideAfter > 0 ? setTimeout(() => this.statusMessage.clear(), hideAfter) : undefined;
		this.statusMessage.value = toDisposable(() => { clearTimeout(show); clearTimeout(hide); entry?.dispose(); });
	}
}
