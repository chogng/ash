import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { getErrorMessage, isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Action2, IMenuService, MenuId, MenuItemAction, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IQuickAccessController, type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
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
	) {}

	provide(picker: IQuickPick<IQuickPickItem>): DisposableStore {
		const disposables = new DisposableStore();
		// Quick Access moves focus into its picker after the provider is created.
		const editor = this.codeEditorService.getFocusedCodeEditor() ?? this.codeEditorService.getActiveCodeEditor();
		const menu = disposables.add(this.menuService.createMenu(MenuId.CommandPalette));
		const updateItems = (): void => {
			const editorCommands = editor?.getSupportedActions().map(action => {
				const keybinding = this.keybindingService.lookupKeybinding(action.id);
				return {
					commandId: action.id,
					label: action.label,
					description: action.id,
					detail: action.alias !== action.label ? action.alias : undefined,
					keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
				};
			}) ?? [];
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
			picker.items = [...editorCommands, ...globalCommands];
		};
		disposables.add(menu.onDidChange(updateItems));
		disposables.add(this.keybindingService.onDidUpdateKeybindings(updateItems));
		disposables.add(picker.onDidAccept(item => {
			picker.hide();
			const command = item as ICommandQuickPickItem;
			const commandId = command.commandId;
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
