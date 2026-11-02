import { Emitter } from '../../../../../../base/common/event.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { Schemas } from '../../../../../../base/common/network.js';
import type { IExtUri } from '../../../../../../base/common/resources.js';
import { URI } from '../../../../../../base/common/uri.js';
import { localize } from '../../../../../../nls.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../../../common/editor.js';
import type { EditorInputSerializer } from '../../../../../services/editor/common/editorInputSerializer.js';
import { EditorInput, type IEditorCloseHandler } from '../../../../../common/editor/editorInput.js';

/** Borrows either the window canvas or one retained conversation from its existing owner. */
export class ChatEditorInput extends EditorInput {
	static readonly TypeID = 'workbench.input.chatSession';
	static readonly EditorID = 'workbench.editor.chatSession';
	readonly typeId = ChatEditorInput.TypeID;
	override readonly editorId = ChatEditorInput.EditorID;
	closeHandler: IEditorCloseHandler | undefined;
	readonly resource: URI;
	private readonly labelChanged = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChanged.event;
	readonly capabilities = EditorInputCapabilities.Singleton;
	readonly readOnly = true;
	readonly showBreadcrumbs = false;

	constructor(public paneId?: string, private title?: string) {
		super();
		this.resource = URI.from({ scheme: Schemas.vscodeChatEditor, path: paneId === undefined ? '/current' : `/session/${encodeURIComponent(paneId)}` });
	}

	/** Materialization changes the conversation key, while the live editor retains its resource identity. */
	updateSession(paneId: string, title: string): void {
		this.paneId = paneId;
		if (this.title === title) return;
		this.title = title;
		this.labelChanged.fire();
	}

	getName(): string { return this.title || localize({ bundle: 'ash.views', key: 'chat' }, 'Chat'); }
	getIcon(): typeof Lxicon.commentDiscussion { return Lxicon.commentDiscussion; }

	override matches(other: IResourceEditorInput, resourceIdentity?: IExtUri): boolean {
		if (other instanceof ChatEditorInput) {
			// The resource stays stable while a draft acquires its durable conversation identity.
			return this.paneId === other.paneId;
		}
		return super.matches(other, resourceIdentity);
	}
}

/** Editor restoration carries only canvas identity; the conversation owner restores its drafts. */
export class ChatEditorInputSerializer implements EditorInputSerializer {
	readonly typeId = ChatEditorInput.TypeID;
	canSerialize(input: IResourceEditorInput): boolean { return input instanceof ChatEditorInput; }
	serialize(input: IResourceEditorInput): unknown {
		if (!(input instanceof ChatEditorInput)) throw new TypeError('Invalid Chat editor input');
		return input.paneId === undefined ? { version: 1 } : { version: 2, paneId: input.paneId, title: input.getName() };
	}
	deserialize(value: unknown): ChatEditorInput {
		if (value && typeof value === 'object' && 'version' in value) {
			if (value.version === 1) return new ChatEditorInput();
			if (value.version === 2 && 'paneId' in value && typeof value.paneId === 'string' && /^(session|untitled):.+$/u.test(value.paneId)
				&& 'title' in value && typeof value.title === 'string') return new ChatEditorInput(value.paneId, value.title);
		}
		throw new TypeError('Invalid Chat editor input');
	}
}
