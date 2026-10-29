import { isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Disposable, DisposableMap, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { getTerminalAutoReplyRules } from '../../../terminal/common/terminalConfiguration.js';
import {
	registerWorkbenchContribution,
	WorkbenchPhase,
	type IWorkbenchContribution,
} from '../../../../common/contributions.js';
import { ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { TerminalAutoRepliesSettingId } from '../common/terminalAutoRepliesConfiguration.js';

/** Projects user configuration into execution-owned rules, including hidden PTYs. */
export class TerminalAutoRepliesContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminalAutoReplies';
	private readonly instances = this._register(new DisposableMap<ITerminalInstance, IDisposable>());
	private updates: Promise<void> = Promise.resolve();

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ITerminalService private readonly terminals: ITerminalService,
	) {
		super();
		for (const instance of terminals.instances) this.observe(instance);
		this._register(terminals.onDidCreateInstance(instance => this.observe(instance)));
		this._register(terminals.onDidDisposeInstance(instance => this.instances.deleteAndDispose(instance)));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(TerminalAutoRepliesSettingId.AutoReplies)) {
					for (const instance of terminals.instances) this.update(instance);
				}
			}),
		);
	}

	private observe(instance: ITerminalInstance): void {
		this.instances.set(
			instance,
			instance.onDidChangeState(state => {
				// Detach revokes backend rules. Reattachment and process reuse must
				// install the destination window's current configuration again.
				if (state === 'running') this.update(instance);
			}),
		);
		this.update(instance);
	}

	private update(instance: ITerminalInstance): void {
		// Preserve configuration-change order even across slow RPCs. Resolve
		// the current process at dispatch, since reuse may retire a queued PTY.
		this.updates = this.updates
			.then(async () => {
				if (this.isDisposed || !this.instances.has(instance) || instance.state !== 'running') return;
				await instance.setAutoReplies(getTerminalAutoReplyRules(this.configuration));
			})
			.catch(error => {
				if (!isCancellationError(error)) onUnexpectedError(error);
			});
	}

	protected override disposeCore(): void {
		for (const instance of this.terminals.instances) {
			void instance.setAutoReplies([]).catch(() => {});
		}
		super.disposeCore();
	}
}

registerWorkbenchContribution(TerminalAutoRepliesContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(TerminalAutoRepliesContribution),
);
