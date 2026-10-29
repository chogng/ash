import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ITerminalProcessService,
	type ITerminalProcessCreation,
	type ITerminalProcessCreateOptions,
} from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { terminalExecutionScope, terminalExecutionScopesEqual } from '../common/remote/terminal.js';
import { BaseTerminalBackend } from '../browser/baseTerminalBackend.js';
import { registerTerminalBackend } from '../browser/agentHostTerminalService.js';
import { LocalPty } from './localPty.js';

/** Local creation is fenced against window target changes without taking transport ownership. */
export class LocalTerminalBackend extends BaseTerminalBackend {
	private workspaceRevision = 0;
	private readonly handles = new Map<number, LocalPty>();
	constructor(
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(processes);
		this._register(workspace.onDidChangeWorkspace(() => this.workspaceRevision++));
		this._register(
			toDisposable(() => {
				for (const pty of this.handles.values()) pty.shutdown(false);
				this.handles.clear();
			}),
		);
	}

	async createProcess(
		options: ITerminalProcessCreateOptions,
		id: number,
		attached?: ITerminalProcessCreation,
		ownership?: ITerminalProcessOwnership,
	): Promise<LocalPty> {
		if (this.isDisposed) throw new CancellationError();
		const scope = terminalExecutionScope(this.workspace.getWorkspace());
		if (scope.remoteAuthority !== undefined) throw new CancellationError();
		const workspaceRevision = this.workspaceRevision;
		const creation = attached ?? (await this.processes.create(options));
		if (
			this.isDisposed ||
			this.workspaceRevision !== workspaceRevision ||
			!terminalExecutionScopesEqual(scope, terminalExecutionScope(this.workspace.getWorkspace()))
		) {
			if (ownership?.canTerminate !== false)
				await this.processes.close({
					terminalId: creation.terminalId,
					...(options.dirId === undefined ? {} : { dirId: options.dirId }),
				});
			throw new CancellationError();
		}
		const pty = this.instantiation.createInstance(
			LocalPty,
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

registerTerminalBackend('local', LocalTerminalBackend);
