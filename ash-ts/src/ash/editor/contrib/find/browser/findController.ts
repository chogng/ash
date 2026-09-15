import "./findWidget.css";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { rot } from "../../../../base/common/numbers.js";
import { type ICodeEditor } from "../../../browser/editorBrowser.js";
import { type TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { Selection } from "../../../common/core/selection.js";
import { Range } from "../../../common/core/range.js";
import { type TextModel } from "../../../common/model/textModel.js";
import { findTextMatches, TextSearchPatternKind, TextSearchQueryError, type TextSearchMatch, type TextModelSearchQuery } from "../../../common/model/textModelSearch.js";
import { createReplaceAllTextMatchesCommand, createReplaceTextMatchCommand, resolveTextSearchReplacement } from "../common/textSearchCommands.js";
import { type TrackedRange } from "../../../common/model/trackedRange.js";
import { type View } from "../../../browser/view.js";
import { EditorOptions, type IEditorFindOptions } from '../../../common/config/editorOptions.js';
import { TrackedRangeStickiness } from '../../../common/model.js';

const DISPLAY_RESULT_LIMIT = 999;
const REPLACE_ALL_RESULT_LIMIT = 100_000;

export interface FindControllerOptions extends IEditorFindOptions {
	readonly wordSeparators?: string;
}

/** Owns Stanza's browser find/replace widget, shortcuts, match navigation, and search decorations. */
export class FindController extends Disposable {
	public static readonly ID = 'editor.contrib.findController';

	readonly element: HTMLDivElement;
	readonly searchInput: HTMLInputElement;
	readonly replaceInput: HTMLInputElement;
	private readonly resultLabel: HTMLSpanElement;
	private readonly replaceRow: HTMLDivElement;
	private readonly replaceToggle: HTMLButtonElement;
	private readonly matchCaseButton: HTMLButtonElement;
	private readonly wholeWordButton: HTMLButtonElement;
	private readonly regularExpressionButton: HTMLButtonElement;
	private readonly findInSelectionButton: HTMLButtonElement;
	private readonly selectionScope = this._register(new MutableDisposable<TrackedRange>());
	private matches: readonly TextSearchMatch[] = Object.freeze([]);
	private currentMatchIndex = -1;
	private replaceVisible = false;
	private matchCase = false;
	private wholeWord = false;
	private regularExpression = false;
	private findInSelection = false;
	private matchesTruncated = false;
	private readonly seedSearchStringFromSelection: NonNullable<IEditorFindOptions['seedSearchStringFromSelection']>;
	private readonly autoFindInSelection: NonNullable<IEditorFindOptions['autoFindInSelection']>;
	private readonly loop: boolean;
	private readonly wordSeparators: string;

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly decorations: TextDecorationCollection<void>,
		options: FindControllerOptions = {},
	) {
		super();
		validateFindControllerOptions(options);
		this.seedSearchStringFromSelection = options.seedSearchStringFromSelection ?? 'selection';
		this.autoFindInSelection = options.autoFindInSelection ?? 'never';
		this.loop = options.loop ?? true;
		this.wordSeparators = options.wordSeparators ?? EditorOptions.wordSeparators.defaultValue;
		if (viewport.textModel !== editor.getModel() || viewport.textModel !== decorations.textModel) {
			this.dispose();
			throw new TypeError("Stanza find dependencies must share one text model");
		}
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-find-widget";
		this.element.hidden = true;
		this.element.setAttribute("role", "dialog");
		this.element.setAttribute("aria-label", "Find and replace");

		const findRow = h(ownerDocument, "div");
		findRow.className = "stanza-editor-find-row";
		this.replaceToggle = createButton(ownerDocument, "Toggle replace", "›");
		this.replaceToggle.classList.add("stanza-editor-find-replace-toggle");
		this.searchInput = h(ownerDocument, "input");
		this.searchInput.className = "stanza-editor-find-input";
		this.searchInput.type = "text";
		this.searchInput.placeholder = "Find";
		this.searchInput.setAttribute("aria-label", "Find");
		this.searchInput.autocomplete = "off";
		this.searchInput.spellcheck = false;
		this.resultLabel = h(ownerDocument, "span");
		this.resultLabel.className = "stanza-editor-find-result";
		this.resultLabel.setAttribute("aria-live", "polite");
		this.matchCaseButton = createToggleButton(ownerDocument, "Match case", "Aa");
		this.wholeWordButton = createToggleButton(ownerDocument, "Match whole word", "W");
		this.regularExpressionButton = createToggleButton(ownerDocument, "Use regular expression", ".*");
		this.findInSelectionButton = createToggleButton(ownerDocument, "Find in selection", "≡");
		const previousButton = createButton(ownerDocument, "Previous match", "↑");
		const nextButton = createButton(ownerDocument, "Next match", "↓");
		const closeButton = createButton(ownerDocument, "Close find", "×");
		findRow.append(this.replaceToggle, this.searchInput, this.resultLabel, this.matchCaseButton, this.wholeWordButton, this.regularExpressionButton, this.findInSelectionButton, previousButton, nextButton, closeButton);

		this.replaceRow = h(ownerDocument, "div");
		this.replaceRow.className = "stanza-editor-replace-row";
		this.replaceRow.hidden = true;
		const replaceSpacer = h(ownerDocument, "span");
		replaceSpacer.className = "stanza-editor-replace-spacer";
		this.replaceInput = h(ownerDocument, "input");
		this.replaceInput.className = "stanza-editor-find-input";
		this.replaceInput.type = "text";
		this.replaceInput.placeholder = "Replace";
		this.replaceInput.setAttribute("aria-label", "Replace");
		this.replaceInput.autocomplete = "off";
		this.replaceInput.spellcheck = false;
		const replaceButton = createButton(ownerDocument, "Replace current match", "Replace");
		const replaceAllButton = createButton(ownerDocument, "Replace all matches", "All");
		this.replaceRow.append(replaceSpacer, this.replaceInput, replaceButton, replaceAllButton);
		this.element.append(findRow, this.replaceRow);
		projectToggle(this.matchCaseButton, this.matchCase);
		projectToggle(this.wholeWordButton, this.wholeWord);
		projectToggle(this.regularExpressionButton, this.regularExpression);
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.decorations.clear();
			this.element.remove();
		}));

		this._register(addDisposableListener(editorInput, "keydown", event => this.handleEditorKeydown(event)));
		this._register(addDisposableListener(this.element, "keydown", event => this.handleWidgetKeydown(event)));
		this._register(addDisposableListener(this.element, "mousedown", event => {
			if (event.target !== this.searchInput && event.target !== this.replaceInput) event.preventDefault();
		}));
		this._register(addDisposableListener(this.searchInput, "input", () => this.refreshMatches({ selectMatch: true })));
		this._register(addDisposableListener(this.replaceToggle, "click", () => this.setReplaceVisible(!this.replaceVisible)));
		this._register(addDisposableListener(this.matchCaseButton, "click", () => {
			this.matchCase = !this.matchCase;
			projectToggle(this.matchCaseButton, this.matchCase);
			this.refreshMatches({ selectMatch: true });
		}));
		this._register(addDisposableListener(this.wholeWordButton, "click", () => {
			this.wholeWord = !this.wholeWord;
			projectToggle(this.wholeWordButton, this.wholeWord);
			this.refreshMatches({ selectMatch: true });
		}));
		this._register(addDisposableListener(this.regularExpressionButton, "click", () => {
			this.regularExpression = !this.regularExpression;
			projectToggle(this.regularExpressionButton, this.regularExpression);
			this.refreshMatches({ selectMatch: true });
		}));
		this._register(addDisposableListener(this.findInSelectionButton, "click", () => this.toggleFindInSelection()));
		this._register(addDisposableListener(previousButton, "click", () => this.selectRelativeMatch(-1)));
		this._register(addDisposableListener(nextButton, "click", () => this.selectRelativeMatch(1)));
		this._register(addDisposableListener(closeButton, "click", () => this.close()));
		this._register(addDisposableListener(replaceButton, "click", () => this.replaceCurrentMatch()));
		this._register(addDisposableListener(replaceAllButton, "click", () => this.replaceAllMatches()));
		this._register(viewport.textModel.onDidChangeContent(() => {
			if (this.visible) this.refreshMatches({ selectMatch: false });
		}));
		this._register(viewport.onDidChangeLayout(() => this.position()));
		this.position();
	}

	get visible(): boolean {
		return !this.element.hidden;
	}

	open(options: { readonly showReplace?: boolean } = {}): void {
		const wasVisible = this.visible;
		this.element.hidden = false;
		this.element.classList.add("visible");
		if (options.showReplace) this.setReplaceVisible(true);
		if (!wasVisible) {
			this.captureSelectionScope();
			const selection = this.selection;
			if (this.autoFindInSelection === 'always' || this.autoFindInSelection === 'multiline' && selection.startLineNumber !== selection.endLineNumber) {
				this.setFindInSelection(true);
			}
			const selectedText = this.seedSearchStringFromSelection === 'never' ? undefined : this.readSelectedSearchText();
			if (selectedText !== undefined) this.searchInput.value = selectedText;
		}
		this.position();
		this.refreshMatches({ selectMatch: true });
		this.searchInput.focus({ preventScroll: true });
		this.searchInput.select();
	}

	close(): void {
		if (!this.visible) return;
		this.element.hidden = true;
		this.element.classList.remove("visible");
		this.matches = Object.freeze([]);
		this.currentMatchIndex = -1;
		this.matchesTruncated = false;
		this.setFindInSelection(false);
		this.selectionScope.clear();
		this.projectFindInSelectionAvailability();
		this.decorations.clear();
		this.editorInput.focus({ preventScroll: true });
	}

	private handleEditorKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		const primaryModifier = event.ctrlKey || event.metaKey;
		if (primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
			stopEvent(event);
			this.open();
			return;
		}
		if (
			(primaryModifier && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "h") ||
			(event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === "f")
		) {
			stopEvent(event);
			this.open({ showReplace: true });
			return;
		}
		if (event.key === "F3" && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			if (!this.visible) this.open();
			this.selectRelativeMatch(event.shiftKey ? -1 : 1);
		}
	}

	private handleWidgetKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === "Escape") {
			stopEvent(event);
			this.close();
			return;
		}
		if (event.key.toLowerCase() === "l" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			stopEvent(event);
			this.toggleFindInSelection();
			return;
		}
		if (event.target === this.searchInput && event.key === "Enter" && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			this.selectRelativeMatch(event.shiftKey ? -1 : 1);
			return;
		}
		if (event.target === this.replaceInput && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			this.replaceCurrentMatch();
		}
	}

	private refreshMatches(options: { readonly selectMatch: boolean }): void {
		const query = this.query;
		const range = this.searchRange;
		let found: readonly TextSearchMatch[];
		try {
			found = findTextMatches(this.model, query, { ...(range ? { range } : {}), resultLimit: DISPLAY_RESULT_LIMIT + 1 });
			this.searchInput.removeAttribute("aria-invalid");
			this.searchInput.classList.remove("invalid");
			this.searchInput.title = "";
		} catch (error) {
			if (!(error instanceof TextSearchQueryError)) throw error;
			this.matches = Object.freeze([]);
			this.currentMatchIndex = -1;
			this.matchesTruncated = false;
			this.decorations.clear();
			this.searchInput.setAttribute("aria-invalid", "true");
			this.searchInput.classList.add("invalid");
			this.searchInput.title = error.message;
			this.resultLabel.textContent = "Invalid expression";
			return;
		}
		const truncated = found.length > DISPLAY_RESULT_LIMIT;
		this.matchesTruncated = truncated;
		this.matches = Object.freeze(found.slice(0, DISPLAY_RESULT_LIMIT));
		this.decorations.replaceAll(this.matches.map(match => ({
			range: match.range,
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: { description: 'find-match', className: 'search-match' },
			metadata: undefined,
		})));
		this.currentMatchIndex = this.findCurrentMatchIndex();
		this.projectResultLabel(truncated);
		if (options.selectMatch && this.currentMatchIndex >= 0) this.selectMatch(this.currentMatchIndex);
	}

	private findCurrentMatchIndex(): number {
		if (this.matches.length === 0) return -1;
		const primaryRange = this.selection;
		const selectionStart = this.model.offsetAt(primaryRange.getStartPosition());
		const selectionEnd = this.model.offsetAt(primaryRange.getEndPosition());
		const exact = this.matches.findIndex(match =>
			this.model.offsetAt(match.range.getStartPosition()) === selectionStart &&
			this.model.offsetAt(match.range.getEndPosition()) === selectionEnd
		);
		if (exact >= 0) return exact;
		const activeOffset = this.model.offsetAt(this.selection.getPosition());
		const following = this.matches.findIndex(match => this.model.offsetAt(match.range.getStartPosition()) >= activeOffset);
		return following >= 0 ? following : 0;
	}

	private selectRelativeMatch(delta: -1 | 1): void {
		if (this.matches.length === 0) return;
		const base = this.currentMatchIndex >= 0 ? this.currentMatchIndex : this.findCurrentMatchIndex();
		const candidate = base + delta;
		const index = this.loop
			? rot(candidate, this.matches.length)
			: Math.max(0, Math.min(this.matches.length - 1, candidate));
		this.selectMatch(index);
	}

	private selectMatch(index: number): void {
		const match = this.matches[index];
		if (!match) return;
		this.currentMatchIndex = index;
		this.editor.setSelection(match.range, 'find');
		this.viewport.revealPosition(match.range.getStartPosition());
		this.projectResultLabel(this.matchesTruncated);
	}

	private replaceCurrentMatch(): void {
		const match = this.matches[this.currentMatchIndex];
		if (!match) return;
		const replacement = this.replacementFor(match);
		this.editor.pushUndoStop();
		this.editor.executeCommand('editor.action.replaceOne', createReplaceTextMatchCommand(this.model, match, replacement));
		this.editor.pushUndoStop();
		this.refreshMatches({ selectMatch: true });
		this.replaceInput.focus({ preventScroll: true });
	}

	private replaceAllMatches(): void {
		let matches: readonly TextSearchMatch[];
		const range = this.searchRange;
		try {
			matches = findTextMatches(this.model, this.query, { ...(range ? { range } : {}), resultLimit: REPLACE_ALL_RESULT_LIMIT });
		} catch (error) {
			if (error instanceof TextSearchQueryError) return;
			throw error;
		}
		if (matches.length === 0) return;
		const replacements = matches.map(match => this.replacementFor(match));
		this.editor.pushUndoStop();
		this.editor.executeCommand('editor.action.replaceAll', createReplaceAllTextMatchesCommand(this.model, matches, replacements));
		this.editor.pushUndoStop();
		this.refreshMatches({ selectMatch: true });
		this.replaceInput.focus({ preventScroll: true });
	}

	private replacementFor(match: TextSearchMatch): string {
		return this.regularExpression
			? resolveTextSearchReplacement(match, this.replaceInput.value)
			: this.replaceInput.value;
	}

	private setReplaceVisible(visible: boolean): void {
		this.replaceVisible = visible;
		this.replaceRow.hidden = !visible;
		projectToggle(this.replaceToggle, visible);
		this.replaceToggle.textContent = visible ? "⌄" : "›";
		this.position();
	}

	private toggleFindInSelection(): void {
		if (!this.findInSelection && !this.selectionScope.value) this.captureSelectionScope();
		this.setFindInSelection(!this.findInSelection);
		this.refreshMatches({ selectMatch: true });
	}

	private setFindInSelection(value: boolean): void {
		this.findInSelection = value && this.selectionScope.value?.range.isEmpty() === false;
		projectToggle(this.findInSelectionButton, this.findInSelection);
		this.projectFindInSelectionAvailability();
	}

	private captureSelectionScope(): void {
		const range = this.selection;
		this.selectionScope.value = range.isEmpty() ? undefined : this.model.trackRange(range, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges);
		this.projectFindInSelectionAvailability();
	}

	private projectFindInSelectionAvailability(): void {
		this.findInSelectionButton.disabled = this.selectionScope.value?.range.isEmpty() !== false;
	}

	private get searchRange(): Range | undefined {
		if (!this.findInSelection) return undefined;
		const range = this.selectionScope.value?.range;
		if (range && !range.isEmpty()) return range;
		this.setFindInSelection(false);
		return undefined;
	}

	private projectResultLabel(truncated: boolean): void {
		if (this.searchInput.value.length === 0) {
			this.resultLabel.textContent = "";
		} else if (this.matches.length === 0) {
			this.resultLabel.textContent = "No results";
		} else {
			const count = truncated ? `${DISPLAY_RESULT_LIMIT}+` : String(this.matches.length);
			this.resultLabel.textContent = `${this.currentMatchIndex + 1} of ${count}`;
		}
	}

	private position(): void {
		if (!this.visible) return;
		const layout = this.viewport.viewportLayout;
		const width = Math.max(0, Math.min(480, layout.viewportSize.width - 24));
		this.element.style.width = `${width}px`;
		this.element.style.left = `${layout.scrollPosition.left + Math.max(0, layout.viewportSize.width - width - 12)}px`;
		this.element.style.top = `${layout.scrollPosition.top + 6}px`;
	}

	private readSelectedSearchText(): string | undefined {
		const selection = this.selection;
		if (selection.isEmpty()) return undefined;
		const text = this.model.getTextInRange(selection);
		return text.length <= 4_096 && !text.includes("\n") ? text : undefined;
	}

	private get query(): TextModelSearchQuery {
		return {
			pattern: this.searchInput.value,
			patternKind: this.regularExpression ? TextSearchPatternKind.RegularExpression : TextSearchPatternKind.Literal,
			matchCase: this.matchCase,
			wholeWord: this.wholeWord,
			wordSeparators: this.wordSeparators,
		};
	}

	private get model(): TextModel {
		return this.viewport.textModel;
	}

	private get selection(): Selection {
		const selection = this.editor.getSelection();
		if (!selection) throw new Error('Find controller requires an attached text model');
		return selection;
	}
}

function createButton(ownerDocument: Document, label: string, text: string): HTMLButtonElement {
	const button = h(ownerDocument, "button");
	button.className = "stanza-editor-find-button";
	button.type = "button";
	button.title = label;
	button.setAttribute("aria-label", label);
	button.textContent = text;
	return button;
}

function createToggleButton(ownerDocument: Document, label: string, text: string): HTMLButtonElement {
	const button = createButton(ownerDocument, label, text);
	button.setAttribute("aria-pressed", "false");
	return button;
}

function projectToggle(button: HTMLButtonElement, checked: boolean): void {
	button.classList.toggle("checked", checked);
	button.setAttribute("aria-pressed", String(checked));
}

function validateFindControllerOptions(options: FindControllerOptions): void {
	if (!options || typeof options !== "object") throw new TypeError("Stanza Find options must be an object");
	for (const [name, value] of Object.entries(options)) {
		if (name === 'wordSeparators' && typeof value === 'string') continue;
		if (name === 'seedSearchStringFromSelection' && ['never', 'always', 'selection'].includes(value as string)) continue;
		if (name === 'autoFindInSelection' && ['never', 'always', 'multiline'].includes(value as string)) continue;
		if (name === 'history' || name === 'replaceHistory') {
			if (value === 'never' || value === 'workspace') continue;
		}
		if (typeof value !== "boolean") throw new TypeError(`Stanza Find option '${name}' must be boolean`);
	}
}
