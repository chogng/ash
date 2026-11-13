import { localize, localize2 } from '../../../../nls.js';
import '../../../../workbench/contrib/searchEditor/browser/searchEditor.contribution.js';
import { isSearchEditorInput, OpenNewEditorCommandId } from '../../../../workbench/contrib/searchEditor/browser/constants.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ExplorerFolderContext, VIEW_ID } from '../../../../workbench/contrib/files/common/files.js';
import { SessionsCodeEditorContext, WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { URI } from '../../../../base/common/uri.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Menus } from '../../../browser/menus.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import { ISessionsSearchService, SessionsSearchService } from './searchService.js';

registerSingleton(ISessionsSearchService, SessionsSearchService, InstantiationType.Delayed);

const canSearchFiles = ContextKeyExpr.and(SessionsCodeEditorContext.isEqualTo(true), ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0));
const openSearchEditor = 'ash.sessions.openSearchEditor';
registerAction2(class OpenSearchEditorAction extends Action2 {
	constructor() {
		super({
			id: openSearchEditor,
			title: localize2('sessions.search.title', 'Search'),
			icon: Lxicon.search,
			precondition: canSearchFiles,
			menu: { id: Menus.TitleBarRightLayout, when: canSearchFiles, group: '1_tools' },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(canSearchFiles)) return;
		const editor = accessor.get(IEditorPart) as EditorParts;
		const groups = editor.getToolGroups(isSearchEditorInput);
		const group = groups.find(group => group.id === editor.activeGroup.id) ?? groups[0];
		const input = group?.activeInput && isSearchEditorInput(group.activeInput) ? group.activeInput : group?.inputs.find(isSearchEditorInput);
		if (group && input) {
			await accessor.get(IEditorService).openEditor(input, { revealIfOpened: true }, { groupId: group.id });
		} else {
			await accessor.get(ICommandService).executeCommand(OpenNewEditorCommandId);
		}
	}
});
MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
	command: { id: 'workbench.action.quickOpen', title: localize2('workbench.editor.goToFile', 'Go to File') },
	when: ContextKeyExpr.and(canSearchFiles, ContextKeyExpr.equals('sessions.editorTool', 'files')),
	group: '1_view',
});
KeybindingsRegistry.registerKeybindingRule({
	command: openSearchEditor,
	keybinding: Keybinding.single(logicalKey('f', { primaryKey: true, shiftKey: true })),
	when: canSearchFiles,
});

registerAction2(class FindInFolderAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.findInFolder',
			title: localize2('sessions.files.findInFolder', 'Find in Folder…'),
			menu: {
				id: MenuId.ExplorerContext,
				when: ContextKeyExpr.and(canSearchFiles, ContextKeyExpr.equals('view', VIEW_ID), ExplorerFolderContext.isEqualTo(true)),
				group: '4_search',
			},
		});
	}

	override async run(accessor: ServicesAccessor, folder?: unknown): Promise<void> {
		if (!accessor.get(IContextKeyService).contextMatchesRules(canSearchFiles)) return;
		if (folder instanceof URI) await accessor.get(ICommandService).executeCommand(OpenNewEditorCommandId, { folder });
	}
});

registerAction2(
	class SearchSessions extends Action2 {
		constructor() {
			super({
				id: 'sessions.search',
				title: localize2('sessions.search.title', 'Search'),
				icon: Lxicon.search,
				f1: true,
				menu: { id: Menus.ActivityBar, group: 'navigation', order: 15 },
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			await accessor.get(ISessionsSearchService).show();
		}
	},
);

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsSearch,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(
				localize('sessions.search.verbosityInvalid', 'Search accessibility verbosity must be boolean'),
			);
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('sessions.search.verbosityTitle', 'Search accessibility help'),
		description: localize(
			'sessions.search.verbosityDescription',
			'Announce how to open accessibility help when Search receives focus.',
		),
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'sessionsSearchHelp',
	when: ContextKeyExpr.has('sessionsSearchFocused'),
	getProvider: accessor => {
		const search = accessor.get(ISessionsSearchService);
		return new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsSearch,
			{ type: AccessibleViewType.Help },
			() =>
				localize(
					'sessions.search.help',
					'Search finds sessions, drafts, projects and schedules by name. Type to filter results. Use Up and Down to select a result, then Enter to open it. Tab reaches the category tabs; use Left and Right to focus a category and Enter or Space to select it. Down returns to the search input. Escape closes Search and restores focus to the previous control.',
				),
			() => search.focus(),
			AccessibilityVerbositySettingId.SessionsSearch,
		);
	},
});
