import { MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { ShowAllCommandsCommandId } from '../../../browser/quickaccess.js';
import { HelpQuickAccessProvider } from '../../../../platform/quickinput/browser/helpQuickAccess.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize } from '../../../../nls.js';
import { ClearCommandHistoryAction, CommandsQuickAccessProvider, ShowAllCommandsAction } from './commandsQuickAccess.js';
import { AnythingQuickAccessProvider } from '../../search/browser/anythingQuickAccess.js';
import { CommandsHistory } from '../../../../platform/quickinput/browser/commandsQuickAccess.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<number>({
	key: 'workbench.commandPalette.history',
	defaultValue: CommandsHistory.DEFAULT_COMMANDS_HISTORY_LENGTH,
	schema: { type: 'number', minimum: 0 },
	parse: value => {
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
			throw new TypeError(localize('quickAccess.historyInvalid', 'Command history length must be a finite non-negative number.'));
		}
		return value;
	},
	setting: {
		get title() { return localize('quickAccess.historyTitle', 'Workbench › Command Palette: History'); },
		get description() { return localize('quickAccess.historyDescription', 'Controls the number of recently used commands to keep in history for the command palette. Set to 0 to disable command history.'); },
		valueType: 'number', minimum: 0, maximum: Number.MAX_VALUE,
	},
});

QuickAccessRegistry.register({
	prefix: '',
	get placeholder() { return localize('quickAccess.searchFiles', 'Search files by name or enter an absolute path or ~/path'); },
	get helpLabel() { return localize('quickAccess.files', 'Files by name, absolute path or ~/path'); },
	ctor: AnythingQuickAccessProvider,
});
QuickAccessRegistry.register({
	prefix: '>',
	get placeholder() { return localize('quickAccess.commandPlaceholder', 'Type the name of a command to run'); },
	get helpLabel() { return localize('quickAccess.commands', 'Commands'); },
	ctor: CommandsQuickAccessProvider,
});
QuickAccessRegistry.register({
	prefix: '?',
	get placeholder() { return localize('quickAccess.helpPlaceholder', 'Select a search mode'); },
	get helpLabel() { return localize('quickAccess.showModes', 'Show Search Modes'); },
	ctor: HelpQuickAccessProvider,
});

registerAction2(ShowAllCommandsAction);
registerAction2(ClearCommandHistoryAction);

MenusRegistry.appendMenuItem(MenuId.EditorContext, {
	group: 'z_commands',
	when: ContextKeyExpr.not(EditorContextKeys.editorSimpleInput.key),
	command: {
		id: ShowAllCommandsCommandId,
		title: localize('workbench.commandPalette', 'Command Palette...'),
	},
	order: 1,
});
