import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import type { Constructor } from '../../../../platform/instantiation/common/descriptors.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { terminalExecutionScope } from '../common/remote/terminal.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ITerminalProcessService,
	type ITerminalProcessCreation,
	type ITerminalProcessCreateOptions,
} from '../../../../platform/terminal/common/terminal.js';
import { AgentHostPty } from './agentHostPty.js';
import { BaseTerminalBackend } from './baseTerminalBackend.js';

const factories = new Map<'local' | 'remote', Constructor<BaseTerminalBackend>>();

/** Static host registration; process membership belongs to each window's backend. */
export function registerTerminalBackend(kind: 'local' | 'remote', ctor: Constructor<BaseTerminalBackend>): void {
	if (factories.has(kind)) throw new Error(`Terminal backend already registered: ${kind}`);
	factories.set(kind, ctor);
}

/** Creates and retires client handles for Ash's actual App Server execution host. */
export class AgentHostTerminalService extends BaseTerminalBackend {
	// Instances own their PTYs. This index routes window shutdown without giving
	// the same disposable a second owner or retiring a replacement's registration.
	private readonly backends = new Map<'local' | 'remote', BaseTerminalBackend>();
	private readonly handles = new Map<number, AgentHostPty>();

	constructor(
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(processes);
		this._register(
			toDisposable(() => {
				for (const pty of this.handles.values()) pty.shutdown(false);
				this.handles.clear();
				this.backends.clear();
			}),
		);
	}

	async createProcess(
		options: ITerminalProcessCreateOptions,
		id: number,
		attached?: ITerminalProcessCreation,
		ownership?: ITerminalProcessOwnership,
	): Promise<AgentHostPty> {
		if (this.isDisposed) throw new CancellationError();
		const kind =
			terminalExecutionScope(this.workspace.getWorkspace()).remoteAuthority === undefined ? 'local' : 'remote';
		const ctor = factories.get(kind);
		if (ctor) {
			let backend = this.backends.get(kind);
			if (!backend) {
				backend = this._register(this.instantiation.createInstance(ctor));
				this.backends.set(kind, backend);
			}
			return backend.createProcess(options, id, attached, ownership);
		}
		const creation = attached ?? (await this.processes.create(options));
		if (this.isDisposed) {
			if (ownership?.canTerminate !== false)
				await this.processes.close({
					terminalId: creation.terminalId,
					...(options.dirId === undefined ? {} : { dirId: options.dirId }),
				});
			throw new CancellationError();
		}
		const pty = this.instantiation.createInstance(
			AgentHostPty,
			id,
			creation,
			options.dirId,
			() => {
				if (this.handles.get(id) === pty) this.handles.delete(id);
			},
			ownership,
		);
		this.handles.set(id, pty);
		return pty;
	}
}
