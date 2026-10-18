import { Disposable } from '../../../../base/common/lifecycle.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IEmbedderTerminalService, type EmbedderTerminal } from '../../../services/terminal/common/embedderTerminalService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITerminalService } from './terminal.js';
import { TERMINAL_VIEW_ID } from '../common/terminal.js';

/** Connects host terminal requests to the window's instance and view owners. */
export class TerminalMainContribution extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'terminalMain';

	constructor(
		@IEmbedderTerminalService embedderTerminals: IEmbedderTerminalService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IViewsService private readonly views: IViewsService,
	) {
		super();
		this._register(embedderTerminals.onDidCreateTerminal(config => {
			void this.createTerminal(config as EmbedderTerminal).catch(onUnexpectedError);
		}));
	}

	private async createTerminal(config: EmbedderTerminal): Promise<void> {
		const instance = await this.terminals.createTerminal({ config, dimensions: { cols: 80, rows: 24 } });
		if (this.isDisposed || !this.terminals.instances.includes(instance)) {
			await instance.close();
			return;
		}
		this.terminals.setActiveInstance(instance);
		await this.views.openView(TERMINAL_VIEW_ID, true);
	}
}
