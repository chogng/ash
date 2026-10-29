import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ITerminalContribution, IXtermTerminal } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { TerminalResizeDimensionsOverlaySettingId } from '../common/terminalResizeDimensionsOverlayConfiguration.js';
import { TerminalResizeDimensionsOverlay } from './terminalResizeDimensionsOverlay.js';

class TerminalResizeDimensionsOverlayContribution extends Disposable implements ITerminalContribution {
	private readonly overlay = this._register(new MutableDisposable<TerminalResizeDimensionsOverlay>());
	private screen: IXtermTerminal | undefined;
	private ready = false;
	private readonly startup = this._register(
		new RunOnceScheduler(() => {
			this.ready = true;
			this.update();
		}, 1000),
	);

	constructor(
		context: ITerminalContributionContext,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(TerminalResizeDimensionsOverlaySettingId.Enabled)) this.update();
			}),
		);
		this._register(
			context.instance.onDidChangeState(state => {
				if (state === 'reconnecting') {
					this.ready = false;
					this.startup.cancel();
					this.overlay.clear();
				} else if (state === 'running' && !this.ready) {
					this.startup.schedule();
				}
			}),
		);
	}

	public xtermReady(screen: IXtermTerminal): void {
		this.screen = screen;
		// Initial layout and output restoration can resize several times. Subscribe
		// after startup settles so opening a terminal does not flash a size hint.
		this.startup.schedule();
	}

	private update(): void {
		const screen = this.screen;
		if (!this.ready || !screen || screen.isDisposed || !this.configuration.getValue<boolean>(TerminalResizeDimensionsOverlaySettingId.Enabled)) {
			this.overlay.clear();
		} else if (!this.overlay.value) {
			this.overlay.value = new TerminalResizeDimensionsOverlay(screen.element, screen);
		}
	}
}

registerTerminalContribution('terminal.resizeDimensionsOverlay', TerminalResizeDimensionsOverlayContribution);
