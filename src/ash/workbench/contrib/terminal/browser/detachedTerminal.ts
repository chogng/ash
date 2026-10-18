import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalScreenHost } from './terminal.js';
import { XtermTerminal } from './xterm/xtermTerminal.js';

/** A passive screen with no process, terminal membership, or stdin destination. */
export class DetachedTerminal extends Disposable {
	readonly xterm: XtermTerminal;
	constructor(container: HTMLElement, @IInstantiationService instantiation: IInstantiationService) {
		super();
		const host: ITerminalScreenHost = {
			processId: -1, state: 'exited', isReadOnly: true,
			onDidChangeCommandStatus: Event.None, onDidChangeState: Event.None,
			resize: () => { /* Geometry belongs to this screen; there is no PTY to resize. */ },
		};
		this.xterm = this._register(instantiation.createInstance(XtermTerminal, container, host));
	}

	async initialize(): Promise<void> {
		await this.xterm.initialize();
		if (this.isDisposed) return;
		this.xterm.setVisible(true);
		const input = this.xterm.raw.textarea;
		if (input) {
			input.readOnly = true;
			input.setAttribute('aria-label', localize('terminal.chat.previewInput', 'Saved terminal output (read only)'));
		}
	}
}
