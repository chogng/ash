import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Menus } from '../../../browser/menus.js';
import { LibraryPage } from './libraryPage.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

registerAction2(class OpenLibrary extends Action2 {
	constructor() {
		super({
			id: 'sessions.open.library', title: localize2({ bundle: 'ash', key: 'sessions.activity.library' }, 'Library'), icon: Lxicon.library,
			toggled: { condition: ContextKeyExpr.has('sessions.activity.librarySelected'), icon: Lxicon.libraryFilled },
			menu: { id: Menus.ActivityBar, group: 'navigation', order: 30 },
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('sessions.show.library');
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Library,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Library accessibility verbosity must be boolean'); }
		return value;
	},
	setting: { valueType: 'boolean', title: localize('library.verbosityTitle', 'Library accessibility help'), description: localize('library.verbosityDescription', 'Announce how to open accessibility help when Library receives focus.') },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `sessionsLibrary${type}`,
		when: ContextKeyExpr.has('sessionsLibraryFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const page = LibraryPage.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(
				AccessibleViewProviderId.Library,
				{ type },
				() => type === AccessibleViewType.Help ? localize('library.help', 'Library stores reusable images independently of conversations. Use Tab to move between categories, search, Import, sorting, view controls and items. Use arrow keys within categories and the item grid; Home and End move to the first or last item. Enter or Space opens asset details. Details shows the source and exact version, lets you add or remove favorites, and choose collection membership. Add to conversation attaches the image to your current Chat draft without sending it. Use in Design places that exact image version on the canvas. Escape closes details and returns to the item. Import accepts PNG, JPEG and WebP images. New collection asks for a name. Search matches names and sources in the selected category. Grid and list views remember your choice. Refresh reads the latest catalog. <keybinding:editor.action.accessibleView> opens a text description of the current items.') : page.getAccessibleContent(),
				() => focused.focus(),
				AccessibilityVerbositySettingId.Library,
			);
		},
	});
}
