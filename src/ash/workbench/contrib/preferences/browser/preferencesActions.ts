import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageModelToolsService, type IToolData } from '../../chat/common/tools/languageModelToolsService.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService, type IOpenSettingsOptions } from '../../../services/preferences/common/preferences.js';
import { OpenKeyboardShortcutsCommandId, OpenSettingsCommandId, OpenSettingsJsonCommandId, OpenSettingsUICommandId } from '../common/preferences.js';
import { ResourceContext } from '../../../common/contextkeys.js';
import { UserSettingsResource } from '../../../services/preferences/common/settingsEditorInput.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';

registerAction2(class OpenSettingsAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
			tooltip: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
			icon: Lxicon.gear,
			menu: [
				{
					id: MenuId.MenubarFileMenu,
					group: '5_preferences',
					order: 1,
				},
			],
			keybinding: {
				primary: Keybinding.single(logicalKey(',', { primaryKey: true })),
			},
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
		// Each host's Preferences owner validates command data before opening or changing its live surface.
		const options = typeof args === 'string' ? { query: args } : args as IOpenSettingsOptions | undefined;
		return accessor.get(IPreferencesService).openSettings(options);
	}
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OpenSettingsCommandId, title: localize2({ bundle: 'ash', key: 'workbench.manageSettings' }, 'Settings') },
	group: '2_configuration',
	order: 2,
});

registerAction2(class OpenKeyboardShortcutsAction extends Action2 {
	constructor() {
		super({
			id: OpenKeyboardShortcutsCommandId,
			title: localize2({ bundle: 'ash', key: 'workbench.openKeyboardShortcuts' }, 'Preferences: Open Keyboard Shortcuts'),
			f1: true,
			menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 1 },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openGlobalKeybindingSettings(false);
	}
});

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: { id: OpenKeyboardShortcutsCommandId, title: localize2({ bundle: 'ash', key: 'workbench.manageKeyboardShortcuts' }, 'Keyboard Shortcuts') },
	group: '2_configuration',
	order: 4,
});

registerAction2(class OpenSettingsJsonAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsJsonCommandId,
			title: localize2({ bundle: 'ash.settings', key: 'json.openCommand' }, 'Preferences: Open User Settings (JSON)'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openUserSettings({ jsonEditor: true });
	}
});

registerAction2(class OpenSettingsUIAction extends Action2 {
	constructor() {
		super({
			id: OpenSettingsUICommandId,
			title: localize2({ bundle: 'ash.settings', key: 'editor.openUI' }, 'Open Settings (UI)'),
			icon: Lxicon.settings,
			f1: true,
			menu: { id: MenuId.EditorTitle, group: 'navigation', order: 1, when: ContextKeyExpr.equals(ResourceContext.key, UserSettingsResource.toString()) },
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openSettings({ jsonEditor: false });
	}
});

registerAction2(class OpenKeybindingsJsonAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.openGlobalKeybindingsFile',
			title: localize2({ bundle: 'ash', key: 'keybindings.openJson' }, 'Preferences: Open Keyboard Shortcuts (JSON)'),
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IPreferencesService).openGlobalKeybindingSettings(true);
	}
});


registerAction2(class ShowAgentToolCatalogAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.showToolCatalog',
			title: localize2({ bundle: 'ash.settings', key: 'capabilities.tools.command' }, 'Developer: Show Agent Tool Catalog'),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const tools = accessor.get(ILanguageModelToolsService);
		const editors = accessor.get(IEditorService);
		await tools.refresh();
		const categories: Record<string, IToolData[]> = Object.create(null);
		for (const tool of [...tools.getAllToolsIncludingDisabled()].sort((left, right) => left.id.localeCompare(right.id))) {
			(categories[tool.category ?? 'unclassified'] ??= []).push(tool);
		}
		// A separate immutable resource preserves the inspected snapshot across refreshes.
		// This is the registered catalog; a particular Turn may have a narrower scope.
		await editors.openEditor({
			resource: URI.from({ scheme: 'ash-tool-catalog', path: '/tools.json', query: generateUuid() }),
			label: localize({ bundle: 'ash.settings', key: 'capabilities.tools.title' }, 'Agent Tool Catalog'),
			languageId: 'json',
			readOnly: true,
			showBreadcrumbs: false,
			initialText: JSON.stringify({
				note: localize({ bundle: 'ash.settings', key: 'capabilities.tools.snapshot' }, 'Registered tool catalog snapshot. Individual turns can have narrower capability scopes. Run Developer: Show Agent Tool Catalog again to refresh.'),
				profiles: tools.profiles.get(),
				categories,
				toolSets: [...tools.toolSets.get()].map(set => ({ id: set.id, kind: set.kind, tools: [...set.getTools()].map(tool => tool.id) })),
			}, undefined, 2),
		}, { pinned: true });
	}
});
