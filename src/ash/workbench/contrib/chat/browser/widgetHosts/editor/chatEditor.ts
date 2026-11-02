import { ConfirmResult } from '../../../../../../platform/dialogs/common/dialogs.js';
import './media/chatEditor.css';
import { h, type IDimension } from '../../../../../../base/browser/dom.js';
import { MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../../../base/common/errors.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import type { ChatViewPane } from '../viewPane/chatViewPane.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID } from '../../../common/chat.js';
import { ChatEditorInput } from './chatEditorInput.js';
import type { IEditorCloseHandler } from '../../../../../common/editor/editorInput.js';

/** Owns an editor host and borrows the window Chat's content for its input lifetime. */
export class ChatEditor extends EditorPane {
	readonly id = ChatEditorInput.EditorID;
	private element!: HTMLElement;
	private view: ChatViewPane | undefined;
	private readonly mount = this._register(new MutableDisposable());
	private shown = false;
	private session: Awaited<ReturnType<ChatViewPane['attachSessionEditor']>> | undefined;
	private input: ChatEditorInput | undefined;
	private closeHandler: IEditorCloseHandler | undefined;
	private inputLoad: AbortController | undefined;

	constructor(
		@IViewsService private readonly views: IViewsService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) { super(ChatEditorInput.EditorID, theme, storage); }

	override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div', { className: 'ash-chat-editor' });
		parent.append(this.element);
		super.create(this.element);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (this.isDisposed) throw new CancellationError();
		if (!(input instanceof ChatEditorInput)) throw new TypeError('Invalid Chat editor input');
		this.clearInput();
		const load = this.inputLoad = new AbortController();
		const lifetime = AbortSignal.any([signal, load.signal]);
		try {
			const view = await this.views.openView<ChatViewPane>(CHAT_VIEW_ID);
			lifetime.throwIfAborted();
			if (!view || typeof view.attachEditor !== 'function') throw new Error('Chat editor requires its window conversation owner');
			if (input.paneId !== undefined) {
				const session = await view.attachSessionEditor(input, this.element, lifetime);
				if (lifetime.aborted) {
					session.dispose();
					lifetime.throwIfAborted();
				}
				this.session = session;
				this.mount.value = session;
				this.input = input;
				input.closeHandler = this.closeHandler = {
					showConfirm: () => true,
					confirm: async () => { await session.widget.captureDraft(); return ConfirmResult.DONT_SAVE; },
				};
				session.widget.setTabId(undefined);
				session.setVisible(this.shown);
				return;
			}
			this.input = input;
			input.closeHandler = this.closeHandler = {
				showConfirm: () => true,
				confirm: async () => { await view.captureActiveDraft(); return ConfirmResult.DONT_SAVE; },
			};
			this.view = view;
			this.mount.value = view.attachEditor(this.element);
			view.setEditorVisible(this.element, this.shown);
		} finally {
			if (this.inputLoad === load) this.inputLoad = undefined;
		}
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.shown = visible;
		this.session?.setVisible(visible);
		this.view?.setEditorVisible(this.element, visible);
	}

	override clearInput(): void {
		this.inputLoad?.abort(new CancellationError());
		this.inputLoad = undefined;
		// A group move may already have installed the target editor's handler on this input.
		if (this.input?.closeHandler === this.closeHandler && this.input) this.input.closeHandler = undefined;
		this.input = undefined;
		this.closeHandler = undefined;
		this.mount.clear();
		this.session = undefined;
		this.view = undefined;
	}

	override layout(dimension: IDimension): void {
		this.element.style.width = `${dimension.width}px`;
		this.element.style.height = `${dimension.height}px`;
	}

	override focus(): void { if (this.session) this.session.widget.focus(); else this.view?.focus(); }
	protected override disposeCore(): void { this.clearInput(); super.disposeCore(); }
}
