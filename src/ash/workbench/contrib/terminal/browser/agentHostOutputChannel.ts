import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';
import { IOutputService, type IOutputChannel } from '../../../services/output/common/output.js';
import { ITerminalService } from '../../../services/terminal/browser/terminal.js';
import { createInstanceCapabilityEventMultiplexer } from './terminalEvents.js';

/** A bounded diagnostic consumer of committed host events; Rust retains the command history. */
export class AgentHostOutputChannel extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminal.agentHostOutput';
	private channel: IOutputChannel | undefined;

	constructor(
		@ITerminalService terminals: ITerminalService,
		@IOutputService private readonly output: IOutputService,
	) {
		super();
		const events = this._register(createInstanceCapabilityEventMultiplexer(terminals.instances, terminals.onDidCreateInstance, terminals.onDidDisposeInstance, TerminalCapability.CommandDetection, capability => capability.onCommandFinished));
		this._register(events.event(({ instance, data }) => {
			this.channel ??= this._register(this.output.createChannel({ id: 'terminal-host', label: localize('terminal.output.host', 'Terminal Host'), kind: 'log', source: 'core' }));
			const detection = instance.capabilities?.get(TerminalCapability.CommandDetection);
			this.channel.appendLine({
				severity: data.status === 'failed' ? 'error' : 'information',
				category: 'terminal',
				text: JSON.stringify({ terminalId: instance.id, commandId: data.commandId, status: data.status, exitCode: data.exitCode, ...(data.isTrusted && !detection?.commandStorageDisabled ? { command: data.command } : {}) }),
			});
		}));
	}
}
