import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalTypeAheadAddon } from './terminalTypeAheadAddon.js';

class TerminalTypeAheadContribution extends Disposable implements ITerminalContribution {
	constructor(private readonly context: ITerminalContributionContext, @IInstantiationService private readonly instantiation: IInstantiationService) { super(); }
	xtermReady(screen: IXtermTerminal): void {
		const addon = this._register(this.instantiation.createInstance(TerminalTypeAheadAddon, this.context.instance, screen));
		screen.raw.loadAddon(addon);
	}
}

registerTerminalContribution('terminal.typeAhead', TerminalTypeAheadContribution);
