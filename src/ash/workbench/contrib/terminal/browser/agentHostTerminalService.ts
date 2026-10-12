import { CancellationError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalProcessService, type ITerminalProcessCreateOptions } from '../../../../platform/terminal/common/terminal.js';
import { AgentHostPty } from './agentHostPty.js';
import { BaseTerminalBackend } from './baseTerminalBackend.js';

/** Creates and retires client handles for Ash's actual App Server execution host. */
export class AgentHostTerminalService extends BaseTerminalBackend {
	// Instances own their PTYs. This index routes window shutdown without giving
	// the same disposable a second owner or retiring a replacement's registration.
	private readonly handles = new Map<number, AgentHostPty>();

	constructor(
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(processes);
		this._register(toDisposable(() => {
			for (const pty of this.handles.values()) pty.shutdown(false);
			this.handles.clear();
		}));
	}

	async createProcess(options: ITerminalProcessCreateOptions, id: number): Promise<AgentHostPty> {
		if (this.isDisposed) throw new CancellationError();
		const creation = await this.processes.create(options);
		if (this.isDisposed) {
			await this.processes.close({ terminalId: creation.terminalId, ...(options.dirId === undefined ? {} : { dirId: options.dirId }) });
			throw new CancellationError();
		}
		const pty = this.instantiation.createInstance(AgentHostPty, id, creation, options.dirId, () => {
			if (this.handles.get(id) === pty) this.handles.delete(id);
		});
		this.handles.set(id, pty);
		return pty;
	}
}
