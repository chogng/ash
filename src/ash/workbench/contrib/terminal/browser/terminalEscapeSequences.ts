/** Display/input sequences. Shell integration parsing remains in the execution host. */
export const enum TerminalEscapeSequences {
	BracketedPasteStart = '\x1b[200~',
	BracketedPasteEnd = '\x1b[201~',
}

/** A parsed text snapshot must not be reinterpreted as OSC, CSI, or cursor control. */
export function terminalTextToDisplayData(text: string): string {
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\n/g, '\r\n');
}
