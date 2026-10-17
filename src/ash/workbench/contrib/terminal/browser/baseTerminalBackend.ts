import type { AgentHostPty } from './agentHostPty.js';
import type { ITerminalProcessCreateOptions, ITerminalProcessCreation } from '../../../../platform/terminal/common/terminal.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type TerminalProcessConnectionState } from '../../../../platform/terminal/common/terminal.js';

/** One window's execution-host lifecycle. Concrete backends own their process handles. */
export abstract class BaseTerminalBackend extends Disposable {
	abstract createProcess(options: ITerminalProcessCreateOptions, id: number, attached?: ITerminalProcessCreation): Promise<AgentHostPty>;
	private state: TerminalProcessConnectionState = 'ready';
	private revision = 0;
	private readonly changed = this._register(new Emitter<TerminalProcessConnectionState>());
	readonly onDidChangeConnectionState = this.changed.event;
	get connectionState(): TerminalProcessConnectionState { return this.state; }

	constructor(@ITerminalProcessService protected readonly processes: ITerminalProcessService) {
		super();
		this._register(processes.onConnectionState(state => {
			this.revision++;
			this.updateState(state);
		}));
		const revision = this.revision;
		void processes.getConnectionState().then(state => {
			if (!this.isDisposed && revision === this.revision) this.updateState(state);
		}, () => {
			if (!this.isDisposed && revision === this.revision) this.updateState('crashed');
		});
	}

	private updateState(state: TerminalProcessConnectionState): void {
		if (state === this.state) return;
		this.state = state;
		this.changed.fire(state);
	}
}
