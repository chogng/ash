import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService } from '../../../services/terminal/browser/terminal.js';

/** Desktop's leased PTYs must receive shutdown before the renderer's IPC lifetime ends. */
export class TerminalNativeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminal.native';

	constructor(
		@ITerminalService private readonly terminals: ITerminalService,
		@ILifecycleService lifecycle: ILifecycleService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this._register(lifecycle.onWillShutdown(event => event.join(
			() => this.closeTerminals(),
			localize('terminal.native.closing', 'Closing terminals'),
			() => this.terminals.instances.length === 0,
		)));
	}

	private async closeTerminals(): Promise<void> {
		const instances = [...this.terminals.instances];
		const results = await Promise.allSettled(instances.map(instance => Promise.resolve().then(() => instance.close())));
		for (const [index, result] of results.entries()) {
			if (result.status === 'rejected') {
				this.log.error('terminal', localize('terminal.native.closeFailed', 'Could not close terminal {0}: {1}', instances[index]!.title, result.reason instanceof Error ? result.reason.message : String(result.reason)));
			}
		}
	}
}
