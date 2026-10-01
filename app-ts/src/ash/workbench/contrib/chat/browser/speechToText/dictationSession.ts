import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IChatInputEditor } from '../widget/input/chatInputEditorRegistry.js';
import { ChatSpeechToTextService, ChatSpeechToTextState } from './chatSpeechToTextService.js';

/** The target editor owns text and undo history; interim recognition stays outside its model. */
export class DictationSession extends Disposable {
	constructor(service: ChatSpeechToTextService, editor: IChatInputEditor, preview: HTMLElement, isVisible: () => boolean) {
		super();
		const clearPreview = (): void => { preview.textContent = ''; preview.hidden = true; };
		this._register(service.onDidUpdateTranscript(({ text, isFinal }) => {
			if (!isVisible()) { return; }
			if (!isFinal) { preview.textContent = text; preview.hidden = !text; return; }
			clearPreview();
			if (!text) { return; }
			editor.insertText(text);
			editor.focus();
			status(localize('chat.input.dictationInserted', 'Dictation added to message'));
		}));
		this._register(service.onDidChangeState(state => { if (state === ChatSpeechToTextState.Idle) { clearPreview(); } }));
	}
}
