import type { IDimension } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane, EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** The tab owns its label. Its host continues to own the chat and draft. */
export class ChatWindowEditorInput extends EditorInput {
	static readonly ID = 'workbench.editors.chatWindow';
	readonly typeId = ChatWindowEditorInput.ID;
	override readonly editorId = ChatWindowEditorInput.ID;
	readonly capabilities = EditorInputCapabilities.Singleton;
	readonly showBreadcrumbs = false;
	private readonly labelChange = this._register(new Emitter<void>());
	readonly onDidChangeLabel = this.labelChange.event;

	constructor(
		private chatResource: URI,
		private title: string,
		readonly element: HTMLElement,
		readonly mount: (container: HTMLElement) => void,
		readonly setVisible: (visible: boolean) => void,
		readonly focus: () => void,
		readonly layout: ((dimension: IDimension) => void) | undefined,
		readonly didReturn: (() => void) | undefined,
	) { super(); }

	get resource(): URI { return this.chatResource; }
	set resource(chat: URI) { this.chatResource = chat; }
	getName(): string { return this.title; }

	setTitle(title: string): void {
		if (this.title === title) return;
		this.title = title;
		this.labelChange.fire();
	}

	canMove(): string { return localize({ bundle: 'ash.workbench', key: 'chatWindow.chatMove' }, 'Use Return to Main Window to move this chat.'); }
}

class ChatWindowEditor extends EditorPane {
	readonly id = ChatWindowEditorInput.ID;
	private container!: HTMLElement;
	private input: ChatWindowEditorInput | undefined;

	constructor(@IThemeService theme: IThemeService, @IStorageService storage: IStorageService) {
		super(ChatWindowEditorInput.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		this.container = parent;
		parent.classList.add('ash-chat-window-editor');
		super.create(parent);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof ChatWindowEditorInput)) throw new TypeError('Expected a chat window editor input');
		input.mount(this.container);
		this.input = input;
	}

	override clearInput(): void { this.input = undefined; }
	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this.input && this.container.contains(this.input.element)) this.input.setVisible(visible);
	}
	override layout(dimension: IDimension): void { this.input?.layout?.(dimension); }
	override focus(): void { this.input?.focus(); }
}

export function registerChatWindowEditor(): void {
	registerEditorPane({
		id: ChatWindowEditorInput.ID,
		name: localize({ bundle: 'ash.workbench', key: 'chatWindow.editor' }, 'Chat'),
		canOpen: input => input instanceof ChatWindowEditorInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: options => options.instantiationService!.createInstance(ChatWindowEditor),
	});
}
