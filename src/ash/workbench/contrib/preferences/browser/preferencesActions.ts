import { resolveCommandsContext } from '../../../browser/parts/editor/editorCommandsContext.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
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
import {
	OpenKeyboardShortcutsCommandId,
	OpenSettingsCommandId,
	OpenSettingsJsonCommandId,
	OpenSettingsUICommandId,
} from '../common/preferences.js';
import { ResourceContext } from '../../../common/contextkeys.js';
import { UserSettingsResource } from '../../../services/preferences/common/settingsEditorInput.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import {
	CONTEXT_KEYBINDINGS_EDITOR,
	CONTEXT_KEYBINDINGS_SEARCH_FOCUS,
	CONTEXT_KEYBINDINGS_SEARCH_HAS_VALUE,
	KEYBINDINGS_EDITOR_COMMAND_RECORD_SEARCH_KEYS,
	KEYBINDINGS_EDITOR_COMMAND_SORTBY_PRECEDENCE,
	KEYBINDINGS_EDITOR_COMMAND_CLEAR_SEARCH_RESULTS,
} from '../common/preferences.js';
import { KeybindingsEditor } from './keybindingsEditor.js';

registerAction2(
	class RecordSearchKeysAction extends Action2 {
		constructor() {
			super({
				id: KEYBINDINGS_EDITOR_COMMAND_RECORD_SEARCH_KEYS,
				title: localize2('keybindings.recordKeys', 'Record Keys'),
				keybinding: {
					primary: Keybinding.single(logicalKey('k', { altKey: true })),
					mac: { primary: Keybinding.single(logicalKey('k', { primaryKey: true, altKey: true })) },
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(
						CONTEXT_KEYBINDINGS_EDITOR.isEqualTo(true),
						CONTEXT_KEYBINDINGS_SEARCH_FOCUS.isEqualTo(true),
					),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof KeybindingsEditor) pane.recordSearchKeys();
		}
	},
);

registerAction2(
	class SortKeybindingsByPrecedenceAction extends Action2 {
		constructor() {
			super({
				id: KEYBINDINGS_EDITOR_COMMAND_SORTBY_PRECEDENCE,
				title: localize2('keybindings.sortByPrecedence', 'Sort by Precedence (Highest first)'),
				keybinding: {
					primary: Keybinding.single(logicalKey('p', { altKey: true })),
					mac: { primary: Keybinding.single(logicalKey('p', { primaryKey: true, altKey: true })) },
					weight: KeybindingWeight.WorkbenchContrib,
					when: CONTEXT_KEYBINDINGS_EDITOR.isEqualTo(true),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof KeybindingsEditor) pane.toggleSortByPrecedence();
		}
	},
);

registerAction2(
	class ClearKeybindingsSearchAction extends Action2 {
		constructor() {
			super({
				id: KEYBINDINGS_EDITOR_COMMAND_CLEAR_SEARCH_RESULTS,
				title: localize2('keybindings.clearSearch', 'Clear Keybindings Search Input'),
				keybinding: {
					primary: Keybinding.single(logicalKey('Escape')),
					weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(
						CONTEXT_KEYBINDINGS_EDITOR.isEqualTo(true),
						CONTEXT_KEYBINDINGS_SEARCH_FOCUS.isEqualTo(true),
						CONTEXT_KEYBINDINGS_SEARCH_HAS_VALUE.isEqualTo(true),
					),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const pane = accessor.get(IEditorService).activeEditorPane;
			if (pane instanceof KeybindingsEditor) pane.clearSearchResults();
		}
	},
);

registerAction2(
	class OpenSettingsAction extends Action2 {
		constructor() {
			super({
				id: OpenSettingsCommandId,
				title: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
				tooltip: localize2({ bundle: 'ash', key: 'workbench.settings' }, 'Ash Settings'),
				icon: Lxicon.gear,
				menu: [{ id: MenuId.MenubarFileMenu, group: '5_preferences', order: 1 }],
				keybinding: { primary: Keybinding.single(logicalKey(',', { primaryKey: true })) },
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			// Each host's Preferences owner validates command data before opening or changing its live surface.
			const options = typeof args === 'string' ? { query: args } : (args as IOpenSettingsOptions | undefined);
			return accessor.get(IPreferencesService).openSettings(options);
		}
	},
);

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: {
		id: OpenSettingsCommandId,
		title: localize2({ bundle: 'ash', key: 'workbench.manageSettings' }, 'Settings'),
	},
	group: '2_configuration',
	order: 2,
});

registerAction2(
	class OpenKeyboardShortcutsAction extends Action2 {
		constructor() {
			super({
				id: OpenKeyboardShortcutsCommandId,
				title: localize2(
					{ bundle: 'ash', key: 'workbench.openKeyboardShortcuts' },
					'Preferences: Open Keyboard Shortcuts',
				),
				f1: true,
				menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 1 },
			});
		}

		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IPreferencesService).openGlobalKeybindingSettings(false);
		}
	},
);

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: {
		id: OpenKeyboardShortcutsCommandId,
		title: localize2({ bundle: 'ash', key: 'workbench.manageKeyboardShortcuts' }, 'Keyboard Shortcuts'),
	},
	group: '2_configuration',
	order: 4,
});

registerAction2(
	class OpenSettingsJsonAction extends Action2 {
		constructor() {
			super({
				id: OpenSettingsJsonCommandId,
				title: localize2(
					{ bundle: 'ash.settings', key: 'json.openCommand' },
					'Preferences: Open User Settings (JSON)',
				),
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IPreferencesService).openUserSettings({ jsonEditor: true });
		}
	},
);

registerAction2(
	class OpenSettingsUIAction extends Action2 {
		constructor() {
			super({
				id: OpenSettingsUICommandId,
				title: localize2({ bundle: 'ash.settings', key: 'editor.openUI' }, 'Open Settings (UI)'),
				icon: Lxicon.settings,
				f1: true,
				menu: {
					id: MenuId.EditorTitle,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.equals(ResourceContext.key, UserSettingsResource.toString()),
				},
			});
		}

		override run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
			const groupId = args.length
				? resolveCommandsContext(args, accessor.get(IEditorGroupsService)).groupedEditors[0]?.group.id
				: undefined;
			return accessor.get(IPreferencesService).openSettings({ jsonEditor: false, groupId });
		}
	},
);

registerAction2(
	class OpenKeybindingsJsonAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.openGlobalKeybindingsFile',
				title: localize2(
					{ bundle: 'ash', key: 'keybindings.openJson' },
					'Preferences: Open Keyboard Shortcuts (JSON)',
				),
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IPreferencesService).openGlobalKeybindingSettings(true);
		}
	},
);

registerAction2(
	class ShowAgentToolCatalogAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.showToolCatalog',
				title: localize2(
					{ bundle: 'ash.settings', key: 'capabilities.tools.command' },
					'Developer: Show Agent Tool Catalog',
				),
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const tools = accessor.get(ILanguageModelToolsService);
			const editors = accessor.get(IEditorService);
			await tools.refresh();
			const categories: Record<string, IToolData[]> = Object.create(null);
			for (const tool of [...tools.getAllToolsIncludingDisabled()].sort((left, right) =>
				left.id.localeCompare(right.id),
			)) {
				(categories[tool.category ?? 'unclassified'] ??= []).push(tool);
			}
			// A separate immutable resource preserves the inspected snapshot across refreshes.
			// This is the registered catalog; a particular Turn may have a narrower scope.
			await editors.openEditor(
				{
					resource: URI.from({ scheme: 'ash-tool-catalog', path: '/tools.json', query: generateUuid() }),
					label: localize({ bundle: 'ash.settings', key: 'capabilities.tools.title' }, 'Agent Tool Catalog'),
					languageId: 'json',
					readOnly: true,
					showBreadcrumbs: false,
					initialText: JSON.stringify(
						{
							note: localize(
								{ bundle: 'ash.settings', key: 'capabilities.tools.snapshot' },
								'Registered tool catalog snapshot. Individual turns can have narrower capability scopes. Run Developer: Show Agent Tool Catalog again to refresh.',
							),
							profiles: tools.profiles.get(),
							categories,
							toolSets: [...tools.toolSets.get()].map(set => ({
								id: set.id,
								kind: set.kind,
								tools: [...set.getTools()].map(tool => tool.id),
							})),
						},
						undefined,
						2,
					),
				},
				{ pinned: true },
			);
		}
	},
);
