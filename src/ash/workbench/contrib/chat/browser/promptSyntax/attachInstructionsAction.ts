import { URI } from '../../../../../base/common/uri.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { IInstructionService } from '../../../../../platform/instructions/common/instructionService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { isRemoteResource } from '../../../../../platform/remote/common/remote.js';
import { pickChatContextItem, type ChatContextSelection, type ChatContextSource } from '../actions/chatContext.js';

export class ChatInstructionsPickerPick implements ChatContextSource {
	public readonly icon = Lxicon.file;
	public get label(): string { return localize('chat.context.instructions', 'Instructions…'); }

	constructor(
		private readonly sessionId: string | undefined,
		@IInstructionService private readonly instructions: IInstructionService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { }

	public isEnabled(): boolean {
		return this.instructions.isAvailable;
	}

	public async asAttachment(signal: AbortSignal): Promise<ChatContextSelection | undefined> {
		const sessionId = this.sessionId;
		if (!this.isEnabled() || signal.aborted) { return undefined; }
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
		if (signal.aborted || !selected || selected.kind === 'back') { return undefined; }
		const { name, path } = selected.item.instruction;
		const root = this.workspace.getWorkspace().folders[0]?.uri;
		const resource = root && isRemoteResource(root) ? root.with({ path, query: '', fragment: '' }) : URI.file(path);
		return {
			acceptInBackground: selected.background,
			attachment: {
				id: `instruction:${path}`,
				kind: 'instruction',
				name,
				resource,
				// Keep the authorized reference; backend catalog changes and permissions apply at submission.
				resolve: async () => ({ name, content: path, kind: 'instruction' }),
			},
		};
	}
}
