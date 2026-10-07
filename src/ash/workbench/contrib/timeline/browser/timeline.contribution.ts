import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import './timeline.service.contribution.js';
import { TimelinePaneId } from '../common/timeline.js';
import { TimelineHasProviderContext } from '../common/timelineService.js';
import { TimelinePane, TimelineFocusedContext } from './timelinePane.js';

/** Registers after Explorer exists; the view remains available in an empty workspace. */
export function registerTimelineView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViews(WorkbenchViewContainerId.Sidebar, [{
		id: TimelinePaneId, title: 'Timeline', localizationKey: { bundle: 'ash.views', key: 'timeline' },
		order: 4, collapsed: true, canToggleVisibility: true, when: TimelineHasProviderContext.isEqualTo(true),
		ctorDescriptor: new SyncDescriptor(TimelinePane),
	}]);
}

registerAction2(class FocusTimelineAction extends Action2 {
	constructor() { super({ id: 'timeline.focus', title: localize2('timeline.focus', 'Focus Timeline View'), f1: true }); }
	public override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView(TimelinePaneId); }
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Timeline, defaultValue: true, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('timeline.verbosityInvalid', 'Timeline accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('timeline.verbosityTitle', 'Timeline accessibility help'); },
		get description() { return localize('timeline.verbosityDescription', 'Announce how to open accessibility help when timeline receives focus.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `timeline${type}`, when: TimelineFocusedContext.isEqualTo(true),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getActiveViewWithId(TimelinePaneId);
			if (!(view instanceof TimelinePane)) return undefined;
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Timeline, { type },
				() => type === AccessibleViewType.Help ? localize('timeline.help', 'Timeline\nUse the arrow keys to move through file history. Press Enter to open an entry or load more entries. Local history entries compare the saved version with the current file. Use the view actions to refresh, pin the current file, or choose sources. Press Alt+F2 to read the history.') : view.getAccessibleContent(),
				() => { if (focused instanceof HTMLElement && focused.isConnected) focused.focus(); else view.focus(); },
				AccessibilityVerbositySettingId.Timeline);
		},
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<number | null>({
	key: 'timeline.pageSize', defaultValue: 50, scope: ConfigurationScope.WINDOW,
	parse(value: unknown): number | null {
		if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) throw new TypeError(localize('timeline.pageSizeInvalid', 'Timeline page size must be a positive integer or null.'));
		return value as number | null;
	},
	schema: { type: ['integer', 'null'], minimum: 1, description: localize('timeline.pageSizeDescription', 'Number of entries per timeline page. Set to null to fit the view height.') },
});
