export interface ITerminalFormatMessageOptions {
	excludeLeadingNewLine?: boolean;
	loudFormatting?: boolean;
}

/** Product messages reset inherited SGR state and use the terminal's themed ANSI palette. */
export function formatMessageForTerminal(message: string, options: ITerminalFormatMessageOptions = {}): string {
	return [
		options.excludeLeadingNewLine ? '' : '\r\n',
		'\x1b[0m\x1b[7m * ',
		options.loudFormatting ? '\x1b[0;104m' : '\x1b[0m',
		` ${message} \x1b[0m\n\r`,
	].join('');
}
