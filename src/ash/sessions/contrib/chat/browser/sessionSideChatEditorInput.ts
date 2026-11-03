import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { DockedEditorInput } from '../../../common/dockedEditorInput.js';
import type { IUntitledChatSession } from '../../../services/sessions/common/session.js';
import { isUntitledSession } from '../../../services/sessions/browser/sessionGridState.js';
import { EditorInputSerializers, requireRecord, requireString } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import type { IEditorCloseHandler } from '../../../../workbench/common/editor/editorInput.js';

type SideChatReference = { readonly draft: IUntitledChatSession; } | {
	readonly sessionId: string;
	readonly threadId: string;
};

/** The tab keeps its identity when its draft becomes a durable conversation. */
export class SessionSideChatEditorInput extends DockedEditorInput {
	static readonly ID = 'sessions.editorInput.sideChat';
	readonly resource: URI;
	closeHandler?: IEditorCloseHandler;

	constructor(id: string, public readonly label: string, public reference: SideChatReference) {
		super();
		this.resource = URI.from({ scheme: 'ash-side-chat', path: `/${id}` });
	}

	getIcon(): typeof Lxicon.chat { return Lxicon.chat; }
}

EditorInputSerializers.registerStatic({
	typeId: SessionSideChatEditorInput.ID,
	canSerialize: input => input instanceof SessionSideChatEditorInput,
	serialize: input => {
		if (!(input instanceof SessionSideChatEditorInput)) throw new TypeError('Invalid Side Chat editor input');
		return { id: input.resource.path.slice(1), label: input.label, reference: input.reference };
	},
	deserialize: value => {
		const record = requireRecord(value, 'Side Chat input');
		const id = requireString(record.id, 'Side Chat identity');
		const label = requireString(record.label, 'Side Chat title');
		const reference = record.reference;
		if (isRecord(reference) && isUntitledSession(reference.draft) && reference.draft.untitledSessionId === id) {
			return new SessionSideChatEditorInput(id, label, { draft: reference.draft });
		}
		const thread = requireRecord(reference, 'Side Chat thread');
		return new SessionSideChatEditorInput(id, label, {
			sessionId: requireString(thread.sessionId, 'Side Chat session identity'),
			threadId: requireString(thread.threadId, 'Side Chat thread identity'),
		});
	},
});
