export const OPEN_AGENTS_WINDOW_COMMAND_ID = 'workbench.action.openAgentsWindow';

/** Message input preferences are independent of the file and reply-code editors. */
export const ChatInputConfiguration = Object.freeze({
	fontFamily: 'chat.input.fontFamily',
	fontSize: 'chat.input.fontSize',
	lineHeight: 'chat.input.lineHeight',
});

export const ChatEditorConfiguration = Object.freeze({
	fontFamily: 'chat.editor.fontFamily',
	fontSize: 'chat.editor.fontSize',
	lineHeight: 'chat.editor.lineHeight',
	wordWrap: 'chat.editor.wordWrap',
});

export const autoAcceptDelaySetting = 'chat.editing.autoAcceptDelay';
