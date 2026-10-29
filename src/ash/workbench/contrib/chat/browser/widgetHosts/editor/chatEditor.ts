import { ConfirmResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import './media/chatEditor.css';
import { h, type IDimension } from '../../../../../../base/browser/dom.js';
import { MutableDisposable, type IDisposable } from '../../../../../../base/common/lifecycle.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import type { IView } from '../../../../../common/views.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../../common/chat.js';
import { ChatEditorInput } from './chatEditorInput.js';

/** The window's conversation owner lends its existing composer instead of creating another model. */
interface ChatEditorHost extends IView {
	attachEditor(parent: HTMLElement): IDisposable;
	setEditorVisible(parent: HTMLElement, visible: boolean): void;
	captureActiveDraft(): Promise<unknown>;
}

/** Owns an editor host and borrows the window Chat's content for its input lifetime. */
export class ChatEditor extends EditorPane {
	readonly id = ChatEditorInput.EditorID;
	private element!: HTMLElement;
	private view: ChatEditorHost | undefined;
	private readonly mount = this._register(new MutableDisposable());
	private shown = false;

	constructor(
		@IViewsService private readonly views: IViewsService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(ChatEditorInput.EditorID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div', { className: 'ash-chat-editor' });
		parent.append(this.element);
		super.create(this.element);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		const view = await this.views.openView<ChatEditorHost>(CHAT_VIEW_ID);
		signal.throwIfAborted();
		if (!view || typeof view.attachEditor !== 'function') throw new Error('Chat editor requires its window conversation owner');
		if (!(input instanceof ChatEditorInput)) throw new TypeError('Invalid Chat editor input');
		input.closeHandler = {
			showConfirm: () => true,
			confirm: async () => {
				await view.captureActiveDraft();
				return ConfirmResult.DONT_SAVE;
			},
		};
		this.view = view;
		this.mount.value = view.attachEditor(this.element);
		view.setEditorVisible(this.element, this.shown);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.shown = visible;
		this.view?.setEditorVisible(this.element, visible);
	}

	override clearInput(): void {
		this.mount.clear();
		this.view = undefined;
	}

	override layout(dimension: IDimension): void {
		this.element.style.width = `${dimension.width}px`;
		this.element.style.height = `${dimension.height}px`;
	}

	override focus(): void {
		this.view?.focus();
	}
	protected override disposeCore(): void {
		this.clearInput();
		super.disposeCore();
	}
}
