import { Range, type IRange } from '../../../../../editor/common/core/range.js';
import { EndOfLinePreference, type ITextModel } from '../../../../../editor/common/model.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';

export interface IChatCopiedInlinePrompt {
	readonly text: string;
	readonly references: readonly {
		readonly attachment: ChatContextAttachment;
		readonly reference: NonNullable<ChatContextAttachment['reference']>;
	}[];
}

/** Projects fully selected references into the LF text written to the clipboard. */
export function projectCopiedChatReferences(
	model: ITextModel,
	ranges: readonly IRange[],
	copiedText: string,
	variables: readonly ChatContextAttachment[],
): IChatCopiedInlinePrompt | undefined {
	const text = copiedText.replace(/\r\n|\r/g, '\n');
	const references: IChatCopiedInlinePrompt['references'][number][] = [];
	let copiedOffset = 0;
	for (const range of ranges) {
		const segment = model.getValueInRange(range, EndOfLinePreference.LF);
		if (text.slice(copiedOffset, copiedOffset + segment.length) !== segment) {
			return undefined;
		}
		const startPosition = Range.getStartPosition(range);
		const start = model.getOffsetAt(startPosition);
		const end = model.getOffsetAt(Range.getEndPosition(range));
		for (const attachment of variables) {
			// Tool selection belongs to the source composer. Copy only its visible label.
			const reference = attachment.reference;
			if (attachment.kind === 'toolSelection' || !reference || reference.start < start || reference.end > end) {
				continue;
			}
			const prefix = Range.fromPositions(startPosition, model.getPositionAt(reference.start));
			const copiedStart = copiedOffset + model.getValueInRange(prefix, EndOfLinePreference.LF).length;
			references.push({
				attachment,
				reference: { start: copiedStart, end: copiedStart + attachment.name.length },
			});
		}
		copiedOffset += segment.length + 1;
	}
	return { text, references };
}
