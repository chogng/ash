import type { Terminal, ITerminalAddon, IMarker } from '@xterm/xterm';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/** Navigates the active screen's existing markers without owning a second command store. */
export class MarkNavigationAddon extends Disposable implements ITerminalAddon {
	private terminal: Terminal | undefined;
	constructor(private readonly getMarkers: () => readonly IMarker[]) {
		super();
	}
	activate(terminal: Terminal): void {
		this.terminal = terminal;
	}
	scrollToPreviousMark(): void {
		this.scroll('previous');
	}
	scrollToNextMark(): void {
		this.scroll('next');
	}

	private scroll(direction: 'previous' | 'next'): void {
		const terminal = this.terminal;
		if (!terminal || this.isDisposed || terminal.buffer.active.type !== 'normal') return;
		const line = terminal.buffer.active.viewportY;
		const available = this.getMarkers()
			.filter(marker => !marker.isDisposed)
			.sort((left, right) => left.line - right.line);
		const target = direction === 'previous' ? available.filter(marker => marker.line < line).at(-1) : available.find(marker => marker.line > line);
		if (target) terminal.scrollToLine(target.line);
	}

	protected override disposeCore(): void {
		this.terminal = undefined;
		super.disposeCore();
	}
}
