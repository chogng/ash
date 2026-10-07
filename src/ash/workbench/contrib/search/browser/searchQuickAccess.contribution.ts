import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { localize } from '../../../../nls.js';
import { SymbolsQuickAccessProvider } from './symbolsQuickAccess.js';
import './searchActionsSymbol.js';

QuickAccessRegistry.register({
	prefix: SymbolsQuickAccessProvider.PREFIX,
	get placeholder() { return localize('quickAccess.symbolPlaceholder', 'Type the name of a symbol in the workspace'); },
	get helpLabel() { return localize('quickAccess.workspaceSymbols', 'Symbols in Workspace'); },
	ctor: SymbolsQuickAccessProvider,
});
