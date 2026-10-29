import type { ITerminalProcessOwnership } from '../../../services/terminal/common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ITerminalProcessService,
	type ITerminalProcessCreation,
} from '../../../../platform/terminal/common/terminal.js';
import type { ITerminalExecutionScope } from '../common/remote/terminal.js';
import { RemoteTerminalChannelClient } from '../common/remote/remoteTerminalChannel.js';
import { AgentHostPty } from './agentHostPty.js';

/** Pins input to its original host while the platform retains reconnection ownership. */
export class RemotePty extends AgentHostPty {
	constructor(
		id: number,
		creation: ITerminalProcessCreation,
		dirId: string | undefined,
		released: () => void,
		private readonly channel: RemoteTerminalChannelClient,
		private readonly scope: ITerminalExecutionScope,
		ownership: ITerminalProcessOwnership | undefined,
		@ITerminalProcessService processes: ITerminalProcessService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super(id, creation, dirId, released, ownership, processes, instantiation);
	}
	protected override assertCanWrite(): void {
		this.channel.assertAuthority(this.scope);
	}
}
