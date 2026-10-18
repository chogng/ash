import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalProcessService, type ITerminalProcessCreation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { terminalExecutionScope } from '../common/remote/terminal.js';
import { AgentHostPty } from '../browser/agentHostPty.js';

/** Local shells retain their cwd across local folder changes, never across a host switch. */
export class LocalPty extends AgentHostPty {
	constructor(id: number, creation: ITerminalProcessCreation, dirId: string | undefined, released: () => void, ownership: ITerminalProcessOwnership | undefined,
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService instantiation: IInstantiationService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { super(id, creation, dirId, released, ownership, processes, instantiation); }
	protected override assertCanWrite(): void {
		if (terminalExecutionScope(this.workspace.getWorkspace()).remoteAuthority !== undefined) throw new CancellationError();
	}
}
