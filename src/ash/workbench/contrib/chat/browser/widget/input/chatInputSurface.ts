import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import type { ActionViewItemProvider } from '../../../../../../base/browser/ui/actionbar/actionbar.js';
import { ButtonActionViewItem } from '../../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import type { Icon } from '../../../../../../base/common/icon.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import type { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { IChatInputEditor } from './chatInputEditorRegistry.js';
import { installChatInputLayout } from './chatInputLayout.js';
import '../media/chat.css';

interface ChatInputSurfaceOptions<T extends IChatInputEditor> {
	readonly createEditor: (container: HTMLElement) => T;
	readonly submit: () => void;
	readonly modelPickerPosition: 'leading' | 'trailing';
	readonly layout?: 'compact';
	readonly actionViewItemProvider: ActionViewItemProvider;
}

/** Renders the composer form and its toolbars. The host supplies state and actions. */
export class ChatInputSurface<T extends IChatInputEditor> extends Disposable {
	readonly form: HTMLFormElement;
	readonly editor: T;
	readonly toolbar: WorkbenchToolBar;
	readonly attachmentToolbar: WorkbenchToolBar | undefined;
	readonly inlineActionsToolbar: WorkbenchToolBar | undefined;
	readonly footer: HTMLElement | undefined;

	constructor(container: HTMLElement, contextMenus: IContextMenuService, options: ChatInputSurfaceOptions<T>) {
		super();
		const document = container.ownerDocument;
		this.form = h(document, 'form', { className: 'ash-chat-input-container' });
		const editorHost = h(document, 'div', { className: 'ash-chat-input-editor-host' });
		container.append(this.form);
		this.form.append(editorHost);
		this.editor = this._register(options.createEditor(editorHost));
		const actionViewItemProvider: ActionViewItemProvider = (action, presentation) =>
			options.actionViewItemProvider(action, presentation)
			?? (action instanceof ChatInputAction ? new ChatInputButtonViewItem(action) : undefined);
		const ariaLabel = localize('chat.input.actions', 'Chat input actions');
		this.toolbar = this._register(new WorkbenchToolBar(this.form, contextMenus, { ariaLabel, actionViewItemProvider }));
		this.toolbar.element.classList.add('ash-chat-input-toolbars');
		this.toolbar.element.classList.toggle('model-picker-trailing', options.modelPickerPosition === 'trailing');
		if (options.layout === 'compact') {
			container.classList.add('compact');
			this.footer = h(document, 'div', { className: 'ash-chat-input-footer' });
			this.attachmentToolbar = this._register(new WorkbenchToolBar(this.form, contextMenus, {
				ariaLabel: localize('chat.context.add', 'Add context'),
				actionViewItemProvider,
			}));
			this.inlineActionsToolbar = this._register(new WorkbenchToolBar(this.form, contextMenus, { ariaLabel, actionViewItemProvider }));
			this.inlineActionsToolbar.element.classList.add('ash-chat-input-toolbars');
			this.footer.append(this.toolbar.element);
			this._register(installChatInputLayout(this.form, this.editor, this.inlineActionsToolbar.element, this.attachmentToolbar.element));
		}
		this._register(addDisposableListener(this.form, 'submit', event => {
			event.preventDefault();
			options.submit();
		}));
		this._register(this.editor.onDidSubmit(() => this.form.requestSubmit()));
		this._register(toDisposable(() => {
			this.form.remove();
			this.footer?.remove();
		}));
	}
}

type ChatInputToolbarPresentation = 'attach' | 'mode' | 'model' | 'mic' | 'dictation-cancel' | 'dictation-finish' | 'voice' | 'send' | 'interrupt';

export class ChatInputAction implements IAction {
	constructor(
		readonly id: string,
		public label: string,
		public tooltip: string,
		readonly icon: Icon | undefined,
		readonly enabled: boolean,
		readonly presentation: ChatInputToolbarPresentation,
		readonly callback: () => void | Promise<void>,
		readonly checked: boolean | undefined = undefined,
	) { }

	run(): void | Promise<void> {
		return this.callback();
	}
}

export class ChatInputButtonViewItem extends ButtonActionViewItem {
	constructor(private readonly inputAction: ChatInputAction) {
		super(inputAction, { buttonStyles: defaultButtonStyles });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		const { presentation } = this.inputAction;
		container.classList.add(`ash-chat-input-${presentation}`);
		container.classList.toggle('disabled', !this.action.enabled);
		this.button.toggleClassName('ash-chat-input-action', true);
		this.button.toggleClassName(`ash-chat-input-${presentation}-action`, true);
		this.button.toggleClassName('disabled', !this.action.enabled);
	}
}
