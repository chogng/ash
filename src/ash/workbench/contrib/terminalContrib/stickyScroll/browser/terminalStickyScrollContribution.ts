import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalStickyScrollOverlay } from './terminalStickyScrollOverlay.js';

/** Each retained terminal screen owns its command header, including moves between hosts. */
export class TerminalStickyScrollContribution extends Disposable implements ITerminalContribution {
	public static readonly ID = 'terminal.stickyScroll';

	constructor(
		private readonly context: ITerminalContributionContext,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) { super(); }

	public xtermReady(xterm: IXtermTerminal): void {
		this._register(this.instantiation.createInstance(TerminalStickyScrollOverlay, this.context.instance, xterm));
	}
}
