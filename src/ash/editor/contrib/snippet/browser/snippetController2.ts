import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type Snippet } from '../common/snippetParser.js';
import { SnippetSession } from './snippetSession.js';

/** Owns tabstop navigation for every snippet source in one editor. */
export class SnippetController2 extends Disposable implements IEditorContribution {
	public static readonly ID = 'snippetController2';

	public static get(editor: ICodeEditor): SnippetController2 | null {
		return editor.getContribution<SnippetController2>(SnippetController2.ID);
	}

	private readonly session = this._register(new MutableDisposable<SnippetSession>());

	constructor(private readonly editor: ICodeEditor) {
		super();
		const domNode = editor.getDomNode();
		if (domNode) {
			// Capture before the view handles Tab as indentation or a completion key.
			this._register(addDisposableListener<KeyboardEvent>(domNode, 'keydown', event => this.handleKeydown(event), true));
		}
		this._register(editor.onDidChangeModel(() => this.cancel()));
	}

	public startSession(model: TextModel, starts: readonly number[], snippet: Snippet, finalOffset = snippet.text.length): void {
		this.assertNotDisposed();
		this.session.clear();
		if (snippet.placeholderGroups.length === 0) return;
		this.session.value = new SnippetSession(model, this.editor, starts, snippet, finalOffset);
	}

	public next(): void {
		this.advance();
	}

	public prev(): void {
		this.retreat();
	}

	public isInSnippet(): boolean {
		return this.session.value !== undefined;
	}

	public cancel(resetSelection = false): void {
		this.session.clear();
		if (resetSelection) {
			const primary = this.editor.getSelection();
			if (primary) this.editor.setSelections([primary]);
		}
	}

	private advance(): boolean {
		const current = this.session.value;
		if (!current) return false;
		const handled = current.selectNext();
		if (current.isDisposed) this.session.clear();
		return handled;
	}

	private retreat(): boolean {
		return this.session.value?.selectPrevious() ?? false;
	}

	private nextChoice(): boolean {
		return this.session.value?.selectNextChoice() ?? false;
	}

	private prevChoice(): boolean {
		return this.session.value?.selectPreviousChoice() ?? false;
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (!this.isInSnippet() || event.defaultPrevented || event.isComposing || !this.editor.hasTextFocus()) return;
		let handled = false;
		if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) {
			handled = event.shiftKey ? this.retreat() : this.advance();
		} else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp')
			&& event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			handled = event.key === 'ArrowDown' ? this.nextChoice() : this.prevChoice();
		} else if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
			this.cancel(true);
			handled = true;
		}
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}
}

registerEditorContribution(SnippetController2.ID, SnippetController2, EditorContributionInstantiation.Eager);
