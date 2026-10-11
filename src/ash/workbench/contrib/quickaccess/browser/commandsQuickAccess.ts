import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { getErrorMessage, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Action2, IMenuService, MenuId, MenuItemAction, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IQuickAccessController, type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { CommandsHistory } from '../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { localize, localize2 } from '../../../../nls.js';
import { ShowAllCommandsCommandId } from '../../../browser/quickaccess.js';

interface ICommandQuickPickItem extends IQuickPickItem {
	readonly commandId: string;
}

export class CommandsQuickAccessProvider implements IQuickAccessProvider {
	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IMenuService private readonly menuService: IMenuService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) { }

	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const disposables = new DisposableStore();
		const history = disposables.add(this.instantiationService.createInstance(CommandsHistory));
		picker.sortByLabel = false;
		// Quick Access moves focus into its picker after the provider is created.
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		const menu = disposables.add(this.menuService.createMenu(MenuId.CommandPalette));
		const updateItems = (): void => {
			// A preview can close while the picker is open; the service owns editor registration.
			const editorActions = editor && this.codeEditorService.listCodeEditors().includes(editor) ? editor.getSupportedActions() : [];
			const editorCommands = editorActions.map(action => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				return {
					commandId: action.id,
					label: action.label,
					description: action.id,
					detail: action.alias !== action.label ? action.alias : undefined,
					keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
				};
			});
			const editorCommandIds = new Set(editorCommands.map(command => command.commandId));
			const globalCommands = menu.getActions()
				.flatMap(([, actions]) => actions)
				.filter((action): action is MenuItemAction => action instanceof MenuItemAction && action.enabled)
				.filter(action => !editorCommandIds.has(action.id))
				.map(action => {
					const keybinding = this.keybindingService.lookupKeybinding(action.id);
					const original = typeof action.item.title === 'string' ? undefined : action.item.title.original;
					return {
						commandId: action.id,
						label: action.label,
						description: action.id,
						detail: original !== action.label ? original : undefined,
						keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
					};
				});
			const query = picker.filterValue(picker.value).trim();
			const normalizedQuery = query.toLocaleLowerCase();
			const commands = [...filterQuickPickItems([...editorCommands, ...globalCommands], query)];
			commands.sort((left, right) => {
				const leftExact = query.length > 0 && [left.label, left.detail].some(label => label?.toLocaleLowerCase() === normalizedQuery);
				const rightExact = query.length > 0 && [right.label, right.detail].some(label => label?.toLocaleLowerCase() === normalizedQuery);
				return Number(rightExact) - Number(leftExact)
					|| (history.peek(right.commandId) ?? 0) - (history.peek(left.commandId) ?? 0)
					|| left.label.localeCompare(right.label);
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
					buttons: recent ? [{
						id: 'removeFromHistory',
						label: localize('quickAccess.removeFromHistory', 'Remove from Command History'),
						iconClass: ThemeIcon.asClassName(Lxicon.close),
					}] : undefined,
				});
			}
			picker.items = picks;
		};
		disposables.add(menu.onDidChange(updateItems));
		disposables.add(this.keybindingService.onDidUpdateKeybindings(updateItems));
		disposables.add(picker.onDidChangeValue(updateItems));
		disposables.add(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.commandPalette.history')) updateItems();
		}));
		disposables.add(this.storageService.onDidChangeValue(event => {
			if (event.scope === StorageScope.PROFILE && event.key === 'commandPalette.mru.cache') updateItems();
		}));
		disposables.add(picker.onDidTriggerItemButton(({ item, button }) => {
			if (button.id === 'removeFromHistory') {
				history.remove((item as ICommandQuickPickItem).commandId);
				picker.show();
			}
		}));
		disposables.add(picker.onDidAccept(item => {
			const command = item as ICommandQuickPickItem;
			const commandId = command.commandId;
			history.push(commandId);
			picker.hide();
			void this.commandService.executeCommand(commandId).catch((error: unknown) => {
				if (isCancellationError(error)) return;
				void this.dialogService.error(
					localize('quickAccess.commandFailed', "Command '{0}' resulted in an error", command.label),
					getErrorMessage(error),
				).catch(onUnexpectedError);
			});
		}));
		updateItems();
		return disposables;
	}
}

export class ClearCommandHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.clearCommandHistory',
			get title() { return localize2('quickAccess.clearCommandHistory', 'Clear Command History'); },
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
	command: { id: ShowAllCommandsCommandId, title: localize2({ bundle: 'ash', key: 'workbench.commandPalette' }, 'Command Palette...') },
	group: '1_command',
	order: 1,
});

export class ShowAllCommandsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllCommandsCommandId,
			get title() { return localize2('quickAccess.showAllCommands', 'Show All Commands'); },
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
		accessor.get(IQuickAccessController).show('>');
	}
}
