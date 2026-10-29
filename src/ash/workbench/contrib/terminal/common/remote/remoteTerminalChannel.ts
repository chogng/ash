import type { ITerminalProcessOwnership } from '../../../../services/terminal/common/terminal.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ITerminalProcessService, type ITerminalProcessCreateOptions, type ITerminalProcessCreation } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { terminalExecutionScope, terminalExecutionScopesEqual, type ITerminalExecutionScope } from './terminal.js';

/** Fences Workbench requests; transport, reconnect tokens and ACKs remain below this channel. */
export class RemoteTerminalChannelClient extends Disposable {
	private revision = 0;
	constructor(
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.revision++));
	}

	async createProcess(
		options: ITerminalProcessCreateOptions,
		attached?: ITerminalProcessCreation,
		ownership?: ITerminalProcessOwnership,
	): Promise<{ readonly creation: ITerminalProcessCreation; readonly scope: ITerminalExecutionScope }> {
		if (this.isDisposed) throw new CancellationError();
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		const revision = this.revision;
		const creation = attached ?? (await this.processes.create(options));
		if (this.isDisposed || revision !== this.revision || !terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspace.getWorkspace()))) {
			if (ownership?.canTerminate !== false)
				await this.processes.close({
					terminalId: creation.terminalId,
					...(options.dirId === undefined ? {} : { dirId: options.dirId }),
				});
			throw new CancellationError();
		}
		return { creation, scope };
	}

	assertAuthority(scope: ITerminalExecutionScope): void {
		// A terminal can outlive a folder change on the same host, but never change hosts.
		if (this.isDisposed || scope.remoteAuthority !== terminalExecutionScope(this.workspace.getWorkspace()).remoteAuthority) throw new CancellationError();
	}
}
