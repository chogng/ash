import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatContextValueItem } from '../attachments/chatContextPickService.js';
import type { IChatWidget } from '../chat.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IInstructionService } from '../../../../../platform/instructions/common/instructionService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { createSshRemoteWorkspaceUri } from '../../../../../platform/remote/common/remote.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { pickChatContextItem } from '../actions/chatContext.js';

export class ChatInstructionsPickerPick implements IChatContextValueItem {
	public readonly type = 'valuePick' as const;
	public readonly icon = Lxicon.file;
	public get label(): string { return localize('chat.context.instructions', 'Instructions…'); }

	constructor(
		private readonly sessionId: string | undefined,
		@IInstructionService private readonly instructions: IInstructionService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) { }

	public isEnabled(): boolean {
		return this.instructions.isAvailable;
	}

	public async asAttachment(_widget: IChatWidget | undefined, signal: AbortSignal = new AbortController().signal): Promise<ChatContextAttachment | undefined> {
		const sessionId = this.sessionId;
		if (!this.isEnabled() || signal.aborted) { return undefined; }
		const connection = this.remote.connection;
		let catalog: ReturnType<IInstructionService['list']> | undefined;
		const selected = await pickChatContextItem(this.quickInput, localize('chat.context.selectInstruction', 'Search instructions by name, description or path'), async query => {
			catalog ??= this.instructions.list(sessionId);
			return filterQuickPickItems((await catalog).map(instruction => ({
				label: instruction.name,
				description: instruction.scope === 'user' ? localize('chat.context.userInstruction', 'User') : localize('chat.context.directoryInstruction', 'Directory'),
				detail: instruction.description ? `${instruction.description} · ${instruction.path}` : instruction.path,
				instruction,
			})), query);
		}, signal);
		if (signal.aborted || !this.isEnabled() || !selected || selected.kind === 'back') { return undefined; }
		const { name, path, resource: ownedResource } = selected.item.instruction;
		if (!ownedResource && connection !== this.remote.connection) { return undefined; }
		// User instructions can live outside every workspace folder; the connection still owns their URI.
		const resource = ownedResource ?? (connection?.kind === 'ssh' ? createSshRemoteWorkspaceUri(connection.host, path)
			: connection?.kind === 'remote' ? URI.from({ scheme: Schemas.ashRemote, authority: connection.authority, path })
				: URI.file(path));
		return {
			id: `instruction:${path}`,
			kind: 'instruction',
			name,
			resource,
			// Keep the authorized reference; backend catalog changes and permissions apply at submission.
			resolve: async () => ({ name, content: path, kind: 'instruction' }),
		};
	}
}
