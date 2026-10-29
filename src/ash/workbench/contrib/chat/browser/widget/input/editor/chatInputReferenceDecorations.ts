import type { IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { themeColorFromId } from '../../../../../../../base/common/themables.js';
import type { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { TrackedRangeStickiness } from '../../../../../../../editor/common/model.js';
import { chatSlashCommandBackground, chatSlashCommandForeground } from '../../../../common/widget/chatColors.js';
import { dynamicVariableDecorationType } from '../../../attachments/chatDynamicVariables.js';

/** Shares reference styling through the editor registry; each input owns one registration lease. */
export function registerChatInputReferenceDecorationType(codeEditorService: ICodeEditorService, decorationType = dynamicVariableDecorationType): IDisposable {
	return codeEditorService.registerDecorationType('chat-context-reference', decorationType, {
		backgroundColor: themeColorFromId(chatSlashCommandBackground),
		color: themeColorFromId(chatSlashCommandForeground),
		borderRadius: 'var(--ash-cornerRadius-small)',
		rangeBehavior: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
	});
}
