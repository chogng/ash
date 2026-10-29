import { localize, localize2 } from '../../../../nls.js';

/** Shared terminal labels used by commands and their editor host. */
export const terminalStrings = {
	terminal: localize('terminal.editor.title', 'Terminal'),
	moveToEditor: localize2('terminal.editor.moveToEditor', 'Terminal: Move Terminal into Editor Area'),
	moveToTerminalPanel: localize2('terminal.editor.moveToPanel', 'Terminal: Move Terminal into Panel'),
	scrollToPreviousCommand: localize2('workbench.action.terminal.scrollToPreviousCommand', 'Terminal: Scroll to Previous Command'),
	scrollToNextCommand: localize2('workbench.action.terminal.scrollToNextCommand', 'Terminal: Scroll to Next Command'),
};
