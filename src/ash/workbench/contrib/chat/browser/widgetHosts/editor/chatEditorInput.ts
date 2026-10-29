import { Event } from '../../../../../../base/common/event.js';
import { Schemas } from '../../../../../../base/common/network.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../../../common/editor.js';
import type { EditorInputSerializer } from '../../../../../services/editor/common/editorInputSerializer.js';
import { EditorInput, type IEditorCloseHandler } from '../../../../../common/editor/editorInput.js';

/** One window canvas follows the window's selected conversation; it never owns a second Session. */
export class ChatEditorInput extends EditorInput {
	static readonly TypeID = 'workbench.input.chatSession';
	static readonly EditorID = 'workbench.editor.chatSession';
	readonly typeId = ChatEditorInput.TypeID;
	closeHandler: IEditorCloseHandler | undefined;
	readonly resource = URI.from({ scheme: Schemas.vscodeChatEditor, path: '/current' });
	readonly onDidChangeLabel = Event.None;
	readonly capabilities = EditorInputCapabilities.Singleton;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;

	getName(): string {
		return localize({ bundle: 'ash.views', key: 'chat' }, 'Chat');
	}
}

/** Editor restoration carries only canvas identity; the conversation owner restores its drafts. */
export class ChatEditorInputSerializer implements EditorInputSerializer {
	readonly typeId = ChatEditorInput.TypeID;
	canSerialize(input: IResourceEditorInput): boolean {
		return input instanceof ChatEditorInput;
	}
	serialize(): unknown {
		return { version: 1 };
	}
	deserialize(value: unknown): ChatEditorInput {
		if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1) throw new TypeError('Invalid Chat editor input');
		return new ChatEditorInput();
	}
}
