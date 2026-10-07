import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, type NotificationHandle } from '../../../../platform/notification/common/notification.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';

export class AccessibilityStatus extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.accessibilityStatus';
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly detectionPrompt = this._register(new MutableDisposable());
	private prompted = false;

	constructor(
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(accessibility.onDidChangeScreenReaderOptimized(() => this.update()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('editor.accessibilitySupport')) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		if (!this.accessibility.isScreenReaderOptimized()) {
			this.entry.clear();
			this.detectionPrompt.clear();
			return;
		}
		if (!this.entry.value) {
			const text = localize('accessibility.screenReaderStatus', 'Screen Reader Optimized');
			this.entry.value = this.statusbar.addEntry({
				text,
				ariaLabel: text,
				tooltip: localize('accessibility.screenReaderStatusHint', 'Configure screen reader optimization'),
				run: () => this.commands.executeCommand('showEditorScreenReaderNotification'),
			}, { id: 'status.editor.screenReaderMode', alignment: StatusbarAlignment.Right, priority: 100.6 });
		}
		if (!this.prompted && this.configuration.getValue('editor.accessibilitySupport') === 'auto') {
			this.prompted = true;
			const prompt = showScreenReaderNotification(this.configuration, this.notifications);
			this.detectionPrompt.value = toDisposable(() => prompt.close());
		}
	}
}

function showScreenReaderNotification(configuration: IConfigurationService, notifications: INotificationService): NotificationHandle {
	const notification = notifications.info(localize('accessibility.screenReaderPrompt', 'Choose how Ash enables screen reader optimization.'), [
		{
			id: 'accessibility.screenReader.auto',
			label: localize('accessibility.screenReaderAuto', 'Follow System Detection'),
			run: async () => { await configuration.updateValue('editor.accessibilitySupport', 'auto'); notification.close(); },
		},
		{
			id: 'accessibility.screenReader.on',
			label: localize('accessibility.screenReaderAlwaysOn', 'Always Enable'),
			run: async () => { await configuration.updateValue('editor.accessibilitySupport', 'on'); notification.close(); },
		},
		{
			id: 'accessibility.screenReader.off',
			label: localize('accessibility.screenReaderAlwaysOff', 'Disable'),
			run: async () => { await configuration.updateValue('editor.accessibilitySupport', 'off'); notification.close(); },
		},
	]);
	return notification;
}

registerAction2(class ShowScreenReaderNotificationAction extends Action2 {
	constructor() {
		super({ id: 'showEditorScreenReaderNotification', title: localize2('accessibility.configureScreenReader', 'Configure Screen Reader Optimization'), f1: true });
	}

	public override run(accessor: ServicesAccessor): void {
		showScreenReaderNotification(accessor.get(IConfigurationService), accessor.get(INotificationService));
	}
});
