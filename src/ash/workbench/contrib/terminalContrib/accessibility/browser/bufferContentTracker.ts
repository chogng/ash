import type { Terminal } from '@xterm/xterm';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/** A text snapshot of the displayed buffer, joining wrapped rows into logical lines. */
export class BufferContentTracker extends Disposable {
	private content: string[] = [];
	get lines(): string[] {
		return this.content;
	}

	constructor(private readonly xterm: { readonly raw: Terminal }) {
		super();
	}

	update(): void {
		if (this.isDisposed) return;
		const buffer = this.xterm.raw.buffer.active;
		const lines: string[] = [];
		// Stop at the cursor or last nonempty row, retaining intentional blank lines.
		let end = buffer.baseY + buffer.cursorY;
		for (let row = buffer.length - 1; row > end; row--) {
			if (buffer.getLine(row)?.translateToString(true)) {
				end = row;
				break;
			}
		}
		for (let row = 0; row <= end; row++) {
			const line = buffer.getLine(row);
			if (!line) continue;
			const text = line.translateToString(!buffer.getLine(row + 1)?.isWrapped);
			if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
			else lines.push(text);
		}
		this.content = lines;
	}
}
