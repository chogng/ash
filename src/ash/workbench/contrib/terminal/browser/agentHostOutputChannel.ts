import { Disposable, DisposableMap, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IOutputService, type IOutputChannel } from '../../../services/output/common/output.js';
import { ITerminalService, type ITerminalInstance } from './terminal.js';

/** A bounded diagnostic consumer of committed host events; Rust retains the command history. */
export class AgentHostOutputChannel extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminal.agentHostOutput';
	private channel: IOutputChannel | undefined;

	constructor(
		@ITerminalService terminals: ITerminalService,
		@IOutputService private readonly output: IOutputService,
	) {
		super();
		const subscriptions = this._register(new DisposableMap<ITerminalInstance, IDisposable>());
		const add = (instance: ITerminalInstance) => {
			if (subscriptions.has(instance)) return;
			subscriptions.set(
				instance,
				instance.onDidChangeCommandStatus(data => {
					if (data.status === 'running') return;
					this.channel ??= this._register(
						this.output.createChannel({
							id: 'terminal-host',
							label: localize('terminal.output.host', 'Terminal Host'),
							kind: 'log',
							source: 'core',
						}),
					);
					this.channel.appendLine({
						severity: data.status === 'failed' ? 'error' : 'information',
						category: 'terminal',
						text: JSON.stringify({
							terminalId: instance.id,
							commandId: data.commandId,
							status: data.status,
							exitCode: data.exitCode,
							...(data.isTrusted && !instance.shellIntegration?.commandStorageDisabled
								? { command: data.command }
								: {}),
						}),
					});
				}),
			);
		};
		for (const instance of terminals.instances) add(instance);
		this._register(terminals.onDidCreateInstance(add));
		this._register(terminals.onDidDisposeInstance(instance => subscriptions.deleteAndDispose(instance)));
	}
}
