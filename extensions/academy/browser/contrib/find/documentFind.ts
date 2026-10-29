import { addDisposableListener, h } from 'ash:editor/base/browser/dom.js';
import type { Button } from 'ash:editor/base/browser/ui/button/button.js';
import type { InputBox } from 'ash:editor/base/browser/ui/inputbox/inputbox.js';
import { createDocumentDecoration } from '../../../common/model/documentDecoration.js';
import type { DocumentNode } from '../../../common/model/document.js';
import { selectionsEqual, type DocumentSelection } from '../../../common/core/documentSelection.js';
import { localize } from 'ash:editor/nls.js';
import type { DocumentFormattingContribution, DocumentFormattingState, DocumentEditorContributionContext } from '../../documentContributions.js';
import { DocumentFormattingControls } from '../../widget/documentFormattingControls.js';
import { createReplaceDocumentMatchesCommand, findDocumentText, getDocumentFindMatchIndex, type DocumentFindMatch } from '../../../common/commands/documentFindCommands.js';

/** View-local search intent; results are always recomputed from the current immutable document. */
export class DocumentFindContribution extends DocumentFormattingControls implements DocumentFormattingContribution {
	private readonly query: InputBox;
	private readonly replacement: InputBox;
	private readonly panel: HTMLDivElement;
	private readonly count: HTMLElement;
	private readonly previous: Button;
	private readonly next: Button;
	private readonly replace: Button;
	private readonly replaceAll: Button;
	private readonly matchCase: Button;
	private readonly wholeWord: Button;
	private state: DocumentFormattingState | undefined;

	constructor(private readonly context: DocumentEditorContributionContext) {
		super(context.container, localize('document.find.group', 'Find and replace'));
		const open = this.addButton(localize('document.find.open', 'Find and replace'), () => this.open());
		this.query = this.addInput(localize('document.find.query', 'Find text'), 'search');
		this.query.inputElement.maxLength = 10_000;
		this.replacement = this.addInput(localize('document.find.replacement', 'Replace with'));
		this.matchCase = this.addButton(localize('document.find.matchCase', 'Match case'), () => {
			this.matchCase.checked = !this.matchCase.checked;
			this.context.invalidateView();
		});
		this.wholeWord = this.addButton(localize('document.find.wholeWord', 'Whole word'), () => {
			this.wholeWord.checked = !this.wholeWord.checked;
			this.context.invalidateView();
		});
		this.matchCase.checked = this.wholeWord.checked = false;
		this.previous = this.addButton(localize('document.find.previous', 'Previous match'), () => this.navigate(-1));
		this.next = this.addButton(localize('document.find.next', 'Next match'), () => this.navigate(1));
		this.replace = this.addButton(localize('document.find.replace', 'Replace'), () => this.runReplace(false));
		this.replaceAll = this.addButton(localize('document.find.replaceAll', 'Replace all'), () => this.runReplace(true));
		this.addButton(localize('document.find.close', 'Close find'), () => this.close());
		this.count = h(this.element.ownerDocument, 'span');
		this.count.setAttribute('role', 'status');
		this.count.setAttribute('aria-live', 'polite');
		this.element.append(this.count);
		this.panel = h(this.element.ownerDocument, 'div');
		this.panel.className = 'stanza-document-find-fields';
		this.panel.append(...Array.from(this.element.children).filter(child => child !== open.domNode));
		this.panel.hidden = true;
		this.element.append(this.panel);
		this._register(this.query.onDidChange(() => this.context.invalidateView()));
		this._register(
			addDisposableListener(this.panel, 'keydown', event => {
				if (event.key === 'Enter' && event.target === this.query.inputElement && !event.isComposing) {
					event.preventDefault();
					this.navigate(event.shiftKey ? -1 : 1);
				} else if (event.key === 'Escape') {
					event.preventDefault();
					event.stopPropagation();
					this.close();
				}
			}),
		);
	}

	setState(state: DocumentFormattingState): void {
		this.state = state;
		this.element.hidden = !state.document;
		this.refresh();
	}

	getDecorations(document: DocumentNode, selection: DocumentSelection | undefined) {
		if (this.panel.hidden) return [];
		return findDocumentText(document, this.query.value, this.options()).map((match, index) =>
			createDocumentDecoration({
				id: `find-${index}`,
				from: match.selection.anchor,
				to: match.selection.head,
				className: selectionsEqual(match.selection, selection) ? 'stanza-document-find-current' : 'stanza-document-find-match',
			}),
		);
	}

	handleKeydown(event: KeyboardEvent): void {
		if (!event.defaultPrevented && !event.isComposing && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
			event.preventDefault();
			this.open();
		}
	}

	private open(): void {
		this.panel.hidden = false;
		this.query.focus();
		this.query.select();
		this.context.invalidateView();
	}

	private close(): void {
		this.panel.hidden = true;
		this.context.invalidateView();
		this.context.focusEditor();
	}

	private options() {
		return { matchCase: this.matchCase.checked, wholeWord: this.wholeWord.checked };
	}
	private matches(): readonly DocumentFindMatch[] {
		return this.state?.document ? findDocumentText(this.state.document, this.query.value, this.options()) : [];
	}
	private selectedIndex(matches: readonly DocumentFindMatch[]): number {
		return matches.findIndex(match => selectionsEqual(match.selection, this.state?.selection));
	}

	private refresh(): void {
		const matches = this.matches();
		const selected = this.selectedIndex(matches);
		this.previous.enabled = this.next.enabled = matches.length > 0;
		this.replace.enabled = this.replaceAll.enabled = !this.state?.readOnly && matches.length > 0;
		this.replacement.enabled = !this.state?.readOnly;
		const count = localize('document.find.count', '{0} of {1} matches', selected + 1, matches.length);
		if (this.count.textContent !== count) this.count.textContent = count;
	}

	private navigate(direction: 1 | -1): void {
		const matches = this.matches();
		if (!matches.length || !this.state?.document) return;
		const index = getDocumentFindMatchIndex(this.state.document, matches, this.state.selection, direction);
		const match = matches[index]!;
		this.context.selectText(match.blockId, match.selection);
	}

	private runReplace(all: boolean): void {
		const query = this.query.value;
		const replacement = this.replacement.value;
		const options = this.options();
		// Resolve again at invocation, including after provider retirement or a remote edit.
		this.context.runDocumentCommand((schema, document, _blockId, selection) => {
			const matches = findDocumentText(document, query, options);
			const selected = matches[getDocumentFindMatchIndex(document, matches, selection, 1, true)];
			return createReplaceDocumentMatchesCommand(schema, document, all ? matches : selected ? [selected] : [], replacement);
		});
	}
}
