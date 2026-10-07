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
import '../../../services/outline/browser/outlineService.js';
import { IOutlinePane, ctxFocused } from './outline.js';
import { OutlinePane } from './outlinePane.js';

/** Registers after Explorer exists; the view remains available in an empty workspace. */
export function registerOutlineView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViews(WorkbenchViewContainerId.Sidebar, [{
		id: IOutlinePane.Id, title: 'Outline', localizationKey: { bundle: 'ash.views', key: 'outline' },
		order: 3, collapsed: true, canToggleVisibility: true,
		ctorDescriptor: new SyncDescriptor(OutlinePane),
	}]);
}

registerAction2(class FocusOutlineAction extends Action2 {
	constructor() { super({ id: 'outline.focus', title: localize2('outline.focus', 'Focus Outline View'), f1: true }); }
	public override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView(IOutlinePane.Id); }
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Outline, defaultValue: true, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('outline.verbosityInvalid', 'Outline accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('outline.verbosityTitle', 'Outline accessibility help'); },
		get description() { return localize('outline.verbosityDescription', 'Announce how to open accessibility help when outline receives focus.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `outline${type}`, when: ctxFocused.isEqualTo(true),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getActiveViewWithId(IOutlinePane.Id);
			if (!(view instanceof OutlinePane)) return undefined;
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Outline, { type },
				() => type === AccessibleViewType.Help ? localize('outline.help', 'Outline\nUse the arrow keys to move through symbols. Press Right Arrow to expand and Left Arrow to collapse. Press Enter to go to a symbol. Press Ctrl+F to find symbols. Use the view actions to sort, follow the cursor, or collapse symbols. Press Alt+F2 to read the symbols.') : view.getAccessibleContent(),
				() => { if (focused instanceof HTMLElement && focused.isConnected) focused.focus(); else view.focus(); },
				AccessibilityVerbositySettingId.Outline);
		},
	});
}
