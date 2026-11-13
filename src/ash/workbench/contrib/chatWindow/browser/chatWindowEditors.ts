import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import type { IResourceEditorInput } from '../../../common/editor.js';

export function getChatWindowEditorTransfers(parts: readonly IEditorPart[], target: (input: IResourceEditorInput) => IEditorGroupView) {
	return parts.flatMap(part => part.groups.flatMap(group => group.inputs.map(input => ({
		group, input, target: target(input),
	}))));
}

export async function moveChatWindowEditors(transfers: ReturnType<typeof getChatWindowEditorTransfers>): Promise<void> {
	const moved: typeof transfers = [];
	try {
		for (const entry of transfers) {
			await entry.group.moveEditorTo(entry.input, entry.target, entry.target.inputs.length);
			moved.push(entry);
		}
	} catch (error) {
		for (const { group, input, target } of moved.reverse()) {
			await target.moveEditorTo(input, group, group.inputs.length);
		}
		throw error;
	}
}
