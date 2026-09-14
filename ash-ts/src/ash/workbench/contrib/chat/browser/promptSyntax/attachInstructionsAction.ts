import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { IInstructionApi, InstructionCatalog, InstructionDescriptor } from '../../../../../platform/instructions/common/instructionApi.js';
import type { ISessionsManagementService } from '../../../../../sessions/services/sessions/common/sessionsManagementService.js';
import type { ChatContextAttachment, ChatContextPick, IChatContextPickService, ResolvedInstructionAttachment } from '../../../../services/chat/common/chatContextService.js';

/** Offers OnDemand Instructions through the existing Chat attachment picker. */
export class ChatInstructionContextContribution extends Disposable {
	constructor(pickers: IChatContextPickService, instructions: IInstructionApi, sessions: ISessionsManagementService) {
		super();
		let catalog: InstructionCatalog | undefined;
		this._register(pickers.registerPicker({
			id: 'chat.instructions',
			label: 'Instructions',
			isEnabled: async () => {
				try {
					catalog = await instructions.list(sessions.active?.session.sessionId);
					return catalog.instructions.some(entry => entry.loadPolicy === 'onDemand');
				} catch {
					catalog = undefined;
					return false;
				}
			},
			providePicks: async query => {
				const current = catalog ?? await instructions.list(sessions.active?.session.sessionId);
				const search = query.trim().toLocaleLowerCase();
				return current.instructions
					.filter(entry => entry.loadPolicy === 'onDemand')
					.filter(entry => !search || entry.name.toLocaleLowerCase().includes(search) || entry.path.toLocaleLowerCase().includes(search))
					.map(toPick);
			},
		}));
	}
}

function toPick(entry: InstructionDescriptor): ChatContextPick<ResolvedInstructionAttachment> {
	return {
		label: entry.name,
		description: entry.path,
		attachment: instructionAttachment(entry),
	};
}

function instructionAttachment(entry: InstructionDescriptor): ChatContextAttachment<ResolvedInstructionAttachment> {
	return {
		id: `${entry.reference.source.type}:${entry.reference.source.type === 'directory' ? entry.reference.source.root : ''}:${entry.reference.relativePath}`,
		kind: 'instruction',
		name: `Instruction: ${entry.name}`,
		resolve: async () => ({ type: 'instruction', reference: entry.reference }),
	};
}
