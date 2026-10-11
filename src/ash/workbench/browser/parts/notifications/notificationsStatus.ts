import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { StatusbarAlignment, type IStatusbarEntry, type IStatusbarEntryAccessor, type IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';

/** Owns the window's history indicator and the status-bar-free Sessions control. */
export class NotificationsStatus extends Disposable {
	private readonly toggleButton: Button | undefined;
	private readonly bell: IStatusbarEntryAccessor | undefined;
	private centerVisible = false;

	constructor(root: HTMLElement, private readonly model: INotificationService, statusbar: IStatusbarService | undefined, private readonly toggle: () => void) {
		super();
		if (statusbar) {
			this.bell = this._register(statusbar.addEntry(this.entry(), { id: 'ash.status.notifications', alignment: StatusbarAlignment.Right, priority: 500 }));
		} else {
			this.toggleButton = this._register(new Button(root, { label: localize('notifications.title', 'Notifications'), presentation: 'secondary', onClick: toggle }));
			this.toggleButton.domNode.classList.add('ash-notifications-toggle');
		}
		this._register(model.onDidAdd(() => this.render()));
		this._register(model.onDidRemove(() => this.render()));
		this.render();
	}

	public update(isCenterVisible: boolean): void {
		this.centerVisible = isCenterVisible;
		this.render();
	}

	private entry(): IStatusbarEntry {
		const label = localize('notifications.showCenter', 'Show Notification Center');
		return { icon: this.model.getNotifications().length ? Lxicon.bellDot : Lxicon.bell, text: '', ariaLabel: label, tooltip: label, run: this.toggle };
	}

	private render(): void {
		this.bell?.update(this.entry());
		if (this.toggleButton) {
			this.toggleButton.hidden = this.model.getNotifications().length === 0;
			this.toggleButton.domNode.setAttribute('aria-label', localize('notifications.showCenter', 'Show Notification Center'));
			this.toggleButton.domNode.setAttribute('aria-expanded', String(this.centerVisible));
			this.toggleButton.domNode.classList.toggle('expanded', this.centerVisible);
		}
	}
}
