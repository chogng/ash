import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { getErrorMessage, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Action2, IMenuService, MenuId, MenuItemAction, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { PickerQuickAccessProvider, TriggerAction, type IPickerQuickAccessItem, type Picks } from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import type { IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { CommandsHistory } from '../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { localize, localize2 } from '../../../../nls.js';
import { ShowAllCommandsCommandId } from '../../../browser/quickaccess.js';
import { commandActionLabel } from '../../../../platform/action/common/action.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';

interface ICommandQuickPickItem extends IPickerQuickAccessItem {
	readonly commandId: string;
}

export class CommandsQuickAccessProvider extends PickerQuickAccessProvider<ICommandQuickPickItem> {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
		@IPreferencesService private readonly preferencesService: IPreferencesService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super('>');
		this.history = this._register(this.instantiationService.createInstance(CommandsHistory));
		// Capture the editor before the picker takes focus.
		this.editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		this.menu = this._register(this.menuService.createMenu(MenuId.CommandPalette));
		this._register(this.menu.onDidChange(() => this.refresh()));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.refresh()));
		this._register(
			this.configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('workbench.commandPalette.history')) this.refresh();
			}),
		);
		this._register(
			this.storageService.onDidChangeValue(event => {
				if (event.scope === StorageScope.PROFILE && event.key === 'commandPalette.mru.cache') this.refresh();
			}),
		);
	}

	private readonly history: CommandsHistory;
	private readonly editor: ReturnType<ICodeEditorService['getActiveCodeEditor']>;
	private readonly menu: ReturnType<IMenuService['createMenu']>;

	protected override _getPicks(query: string): Picks<ICommandQuickPickItem> {
		const { editor, history, menu } = this;
		// A preview can close while the picker is open; the service owns editor registration.
		const editorActions = editor && this.codeEditorService.listCodeEditors().includes(editor) ? editor.getSupportedActions() : [];
		const editorCommands = editorActions.map(action => {
			const keybinding = this.keybindingService.lookupKeybinding(action.id);
			return {
				commandId: action.id,
				label: action.label,
				description: action.id,
				detail: action.alias !== action.label ? action.alias : undefined,
				keybinding,
			};
		});
		const editorCommandIds = new Set(editorCommands.map(command => command.commandId));
		const globalCommands = menu
			.getActions()
			.flatMap(([, actions]) => actions)
			.filter((action): action is MenuItemAction => action instanceof MenuItemAction && action.enabled)
			.filter(action => !editorCommandIds.has(action.id))
			.map(action => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				const category = action.item.category;
				const title = action.item.title;
				const label = category ? localize('quickAccess.categoryTitle', '{0}: {1}', commandActionLabel(category), action.label) : action.label;
				const originalTitle = typeof title === 'string' ? title : title.original;
				const original = category
					? localize2('quickAccess.categoryTitle', '{0}: {1}', typeof category === 'string' ? category : category.original, originalTitle).original
					: typeof title === 'string'
						? undefined
						: originalTitle;
				return {
					commandId: action.id,
					label,
					description: action.id,
					detail: original !== label ? original : undefined,
					keybinding,
				};
			});
		const normalizedQuery = query.toLocaleLowerCase();
		const commands = [...filterQuickPickItems([...editorCommands, ...globalCommands], query)];
		commands.sort((left, right) => {
			const leftExact = query.length > 0 && [left.label, left.detail].some(label => label?.toLocaleLowerCase() === normalizedQuery);
			const rightExact = query.length > 0 && [right.label, right.detail].some(label => label?.toLocaleLowerCase() === normalizedQuery);
			return Number(rightExact) - Number(leftExact) || (history.peek(right.commandId) ?? 0) - (history.peek(left.commandId) ?? 0) || left.label.localeCompare(right.label);
		});
		const picks: (ICommandQuickPickItem | IQuickPickSeparator)[] = [];
		let section: boolean | undefined;
		for (const command of commands) {
			const recent = history.peek(command.commandId) !== undefined;
			if (recent !== section) {
				if (recent || section !== undefined) {
					picks.push({
						type: 'separator',
						label: recent ? localize('quickAccess.recentlyUsed', 'recently used') : localize('quickAccess.otherCommands', 'other commands'),
					});
				}
				section = recent;
			}
			picks.push({
				...command,
				accept: () => {
					// Hiding disposes the provider. Persist MRU through its storage owner afterward.
					using acceptedHistory = this.instantiationService.createInstance(CommandsHistory);
					acceptedHistory.push(command.commandId);
					void this.commandService.executeCommand(command.commandId).catch((error: unknown) => {
						if (isCancellationError(error)) return;
						void this.dialogService.error(localize('quickAccess.commandFailed', "Command '{0}' resulted in an error", command.label), getErrorMessage(error)).catch(onUnexpectedError);
					});
				},
				trigger: buttonIndex => {
					if (buttonIndex === 0) {
						// Restore the displaced focus before Preferences opens and focuses its editor.
						this.quickInputService.currentQuickInput?.hide();
						void this.preferencesService.openGlobalKeybindingSettings(false, { query: `@command:${command.commandId}` }).catch(onUnexpectedError);
						return TriggerAction.CLOSE_PICKER;
					}
					history.remove(command.commandId);
					return TriggerAction.REFRESH_PICKER;
				},
				buttons: [
					{
						id: 'configureKeybinding',
						label: localize('quickAccess.configureKeybinding', 'Configure Keybinding'),
						iconClass: ThemeIcon.asClassName(Lxicon.gear),
					},
					...(recent
						? [
								{
									id: 'removeFromHistory',
									label: localize('quickAccess.removeFromHistory', 'Remove from Command History'),
									iconClass: ThemeIcon.asClassName(Lxicon.close),
								},
							]
						: []),
				],
			});
		}
		return picks;
	}
}

export class ClearCommandHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.clearCommandHistory',
			get title() {
				return localize2('quickAccess.clearCommandHistory', 'Clear Command History');
			},
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (CommandsHistory.getConfiguredCommandHistoryLength(configuration) === 0) return;
		const { confirmed } = await accessor.get(IDialogService).confirm({
			message: localize('quickAccess.confirmClearHistory', 'Do you want to clear the history of recently used commands?'),
			primaryButton: localize('quickAccess.clearHistoryButton', 'Clear'),
		});
		if (confirmed) CommandsHistory.clearHistory(configuration, accessor.get(IStorageService));
	}
}

MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	command: {
		id: ShowAllCommandsCommandId,
		title: localize2({ bundle: 'ash', key: 'workbench.commandPalette' }, 'Command Palette...'),
	},
	group: '1_command',
	order: 1,
});

export class ShowAllCommandsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllCommandsCommandId,
			get title() {
				return localize2('quickAccess.showAllCommands', 'Show All Commands');
			},
			menu: [
				{ id: MenuId.MenubarViewMenu, group: '1_commands', order: 1 },
				{ id: MenuId.MenubarHelpMenu, group: '1_commands', order: 1 },
			],
			keybinding: {
				primary: Keybinding.single(logicalKey('p', { primaryKey: true, shiftKey: true })),
				secondary: [Keybinding.single(logicalKey('F1'))],
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickInputService).quickAccess.show('>');
	}
}
