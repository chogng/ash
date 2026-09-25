import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { HelpQuickAccessProvider } from '../../../../platform/quickinput/browser/helpQuickAccess.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize } from '../../../../nls.js';
import { CommandsQuickAccessProvider, ShowAllCommandsAction } from './commandsQuickAccess.js';

QuickAccessRegistry.register({
	prefix: '',
	get placeholder() { return localize('quickAccess.searchCommands', 'Search commands (type >, @, or ? for modes)'); },
	get helpLabel() { return localize('quickAccess.commands', 'Commands'); },
	ctor: CommandsQuickAccessProvider,
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
