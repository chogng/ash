import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { matchesSubString } from '../../../../base/common/filters.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { PickerQuickAccessProvider, type IPickerQuickAccessItem, type Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { DEBUG_CONSOLE_VIEW_ID, IDebugService } from '../common/debug.js';
import { DEBUG_CONSOLE_QUICK_ACCESS_PREFIX } from './debugCommands.js';

/** Includes retained ended consoles without constructing a second session catalog. */
export class DebugConsoleQuickAccess extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IViewsService private readonly views: IViewsService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(DEBUG_CONSOLE_QUICK_ACCESS_PREFIX, { canAcceptInBackground: true });
	}

	protected override _getPicks(filter: string, resources: DisposableStore): Picks<IPickerQuickAccessItem> {
		const model = this.debug.replModel;
		resources.add(model.onDidChange(() => this.refresh()));
		return model.sessions.flatMap(session => {
			const highlights = matchesSubString(filter, session.label);
			if (!highlights) return [];
			return [
				{
					label: session.label,
					description: session.canEvaluate ? undefined : localize('debug.state.terminated', 'terminated'),
					accept: (_mods, event) => {
						if (!model.sessions.some(candidate => candidate.id === session.id)) return;
						model.selectSession(session.id);
						void this.views.openView(DEBUG_CONSOLE_VIEW_ID, !event.inBackground).catch(error => this.notifications.error(error));
					},
				} satisfies IPickerQuickAccessItem,
			];
		});
	}
}
