import './renameWidget.css';
import { h, addDisposableListener, getActiveElement, stopEvent } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type View } from '../../../browser/view.js';
import { Range } from '../../../common/core/range.js';

export const CONTEXT_RENAME_INPUT_VISIBLE = new RawContextKey<boolean>('renameInputVisible', false);
export const CONTEXT_RENAME_INPUT_FOCUSED = new RawContextKey<boolean>('renameInputFocused', false);

export interface RenameWidgetResult { readonly newName: string; readonly wantsPreview: boolean; }

/** Owns input completion and focus; provider requests and edit submission belong to RenameController. */
export class RenameWidget extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly input: InputBox;
	private readonly status: HTMLElement;
	private readonly visible: IContextKey<boolean>;
	private readonly focused: IContextKey<boolean>;
	private readonly cancellation = this._register(new MutableDisposable());
	private complete: ((value: RenameWidgetResult | undefined) => void) | undefined;
	private supportsPreview = false;

	constructor(private readonly editor: ICodeEditor, private readonly viewport: View, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		this.visible = CONTEXT_RENAME_INPUT_VISIBLE.bindTo(contextKeys);
		this.focused = CONTEXT_RENAME_INPUT_FOCUSED.bindTo(contextKeys);
		this.domNode = h(viewport.domNode.domNode.ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-rename';
		this.domNode.hidden = true;
		this.input = this._register(new InputBox(this.domNode, { ariaLabel: localize('rename.newName', 'New symbol name') }));
		this.input.inputElement.classList.add('stanza-editor-rename-input');
		this.status = h(this.domNode.ownerDocument, 'span');
		this.status.className = 'stanza-editor-rename-status';
		this.status.setAttribute('aria-live', 'polite');
		this.domNode.append(this.status);
		viewport.domNode.domNode.append(this.domNode);
		this._register(toDisposable(() => { this.cancelInput(false, 'dispose'); this.domNode.remove(); }));
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.domNode, 'mousedown', event => event.stopPropagation()));
		this._register(this.input.onDidFocus(() => this.focused.set(true)));
		this._register(this.input.onDidBlur(() => this.focused.set(false)));
		this._register(this.input.onDidChange(() => {
			this.input.inputElement.removeAttribute('aria-invalid');
			this.status.textContent = this.inputHint;
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing) { return; }
			if (event.key === 'Escape') {
				stopEvent(event);
				editor.trigger('keyboard', 'cancelRenameInput', {});
			} else if (event.key === 'Enter' && !event.altKey && (!event.ctrlKey && !event.metaKey || this.supportsPreview)) {
				stopEvent(event);
				editor.trigger('keyboard', event.ctrlKey || event.metaKey ? 'acceptRenameInputWithPreview' : 'acceptRenameInput', {});
			}
		}));
	}

	public getInput(where: Range, currentName: string, signal: AbortSignal, supportsPreview: boolean): Promise<RenameWidgetResult | undefined> {
		this.cancelInput(false, 'new input');
		this.supportsPreview = supportsPreview;
		this.input.value = currentName;
		this.status.textContent = this.inputHint;
		const coordinates = this.viewport.getPositionContentCoordinates(where.getStartPosition());
		this.domNode.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
		this.domNode.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
		const result = new Promise<RenameWidgetResult | undefined>(resolve => { this.complete = resolve; });
		this.cancellation.value = addDisposableListener(signal, 'abort', () => this.cancelInput(true, 'request cancelled'));
		this.domNode.hidden = false;
		this.visible.set(true);
		this.input.focus();
		this.input.select();
		return result;
	}

	public acceptInput(wantsPreview: boolean): void {
		const newName = this.input.value.trim();
		if (!this.complete) { return; }
		if (!newName) {
			this.input.inputElement.setAttribute('aria-invalid', 'true');
			this.status.textContent = localize('rename.emptyName', 'Name cannot be empty');
			return;
		}
		this.input.readOnly = true;
		this.domNode.setAttribute('aria-busy', 'true');
		const complete = this.complete;
		this.complete = undefined;
		complete({ newName, wantsPreview });
	}
	private get inputHint(): string {
		return this.supportsPreview
			? localize('rename.inputPreviewHint', 'Enter to rename, Ctrl+Enter or Command+Enter to preview, Escape to cancel')
			: localize('rename.inputHint', 'Enter to rename, Escape to cancel');
	}
	public cancelInput(focusEditor: boolean, _caller: string): void {
		const restore = focusEditor && this.domNode.contains(getActiveElement(this.domNode.ownerDocument));
		this.cancellation.clear();
		const complete = this.complete;
		this.complete = undefined;
		this.domNode.hidden = true;
		this.visible.reset();
		this.focused.reset();
		this.domNode.removeAttribute('aria-busy');
		this.input.readOnly = false;
		this.input.inputElement.removeAttribute('aria-invalid');
		this.input.value = '';
		this.status.textContent = '';
		complete?.(undefined);
		if (restore && !this.isDisposed) { this.editor.focus(); }
	}
}
