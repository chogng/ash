import type { ITerminalAddon, Terminal } from '@xterm/xterm';

/** Reads logical lines from the original parsed screen; wrapped rows have no newline. */
export class LineDataEventAddon implements ITerminalAddon {
	private terminal: Terminal | undefined;
	activate(terminal: Terminal): void {
		this.terminal = terminal;
	}
	dispose(): void {
		this.terminal = undefined;
	}

	getBufferText(maxCharacters: number): string | undefined {
		const terminal = this.terminal;
		if (!terminal) return undefined;
		let content = terminal.getSelection();
		if (!content) {
			const buffer = terminal.buffer.active;
			const lines: string[] = [];
			let characters = 0;
			for (let index = buffer.length - 1; index >= 0; index--) {
				const line = buffer.getLine(index)!;
				const text = line.translateToString(!buffer.getLine(index + 1)?.isWrapped);
				if (!text && !lines.length) continue;
				lines.push(text);
				characters += text.length + (line.isWrapped ? 0 : 1);
				if (!line.isWrapped) lines.push('\n');
				if (characters > maxCharacters + 1) break;
			}
			content = lines.reverse().join('').trimEnd().replace(/^\n/, '');
		}
		return content.length > maxCharacters ? `[Earlier output omitted]\n${content.slice(-maxCharacters)}` : content;
	}
}
