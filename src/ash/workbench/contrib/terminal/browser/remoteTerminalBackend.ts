import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalProcessService, type ITerminalProcessCreation, type ITerminalProcessCreateOptions } from '../../../../platform/terminal/common/terminal.js';
import { RemoteTerminalChannelClient } from '../common/remote/remoteTerminalChannel.js';
import { BaseTerminalBackend } from './baseTerminalBackend.js';
import { RemotePty } from './remotePty.js';

/** Per-window remote handle lifetime; raw transport leases remain with the platform service. */
export class RemoteTerminalBackend extends BaseTerminalBackend {
	private readonly channel: RemoteTerminalChannelClient;
	private readonly handles = new Map<number, RemotePty>();
	constructor(
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super(processes);
		this.channel = this._register(instantiation.createInstance(RemoteTerminalChannelClient));
		this._register(
			toDisposable(() => {
				for (const pty of this.handles.values()) pty.shutdown(false);
				this.handles.clear();
			}),
		);
	}

	async createProcess(options: ITerminalProcessCreateOptions, id: number, attached?: ITerminalProcessCreation, ownership?: ITerminalProcessOwnership): Promise<RemotePty> {
		if (this.isDisposed) throw new CancellationError();
		const { creation, scope } = await this.channel.createProcess(options, attached, ownership);
		if (this.isDisposed) {
			if (ownership?.canTerminate !== false)
				await this.processes.close({
					terminalId: creation.terminalId,
					...(options.dirId === undefined ? {} : { dirId: options.dirId }),
				});
			throw new CancellationError();
		}
		const pty = this.instantiation.createInstance(
			RemotePty,
			id,
			creation,
			options.dirId,
			() => {
				if (this.handles.get(id) === pty) this.handles.delete(id);
			},
			this.channel,
			scope,
			ownership,
		);
		this.handles.set(id, pty);
		return pty;
	}
}
