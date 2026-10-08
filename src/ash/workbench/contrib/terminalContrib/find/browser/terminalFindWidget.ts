import type { ISearchOptions } from '@xterm/addon-search';
import { addDisposableListener, h, stopEvent } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { FindReplaceState, type INewFindReplaceState } from '../../../../../editor/contrib/find/browser/findState.js';
import { localize } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { ITerminalInstance } from '../../../terminal/browser/terminal.js';
import type { XtermTerminal } from '../../../terminal/browser/xterm/xtermTerminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import './media/terminalFind.css';

/** Owns query controls for one retained terminal; xterm owns matches and selection. */
export class TerminalFindWidget extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly input: InputBox;
	private readonly resultDomNode: HTMLElement;
	public readonly state = this._register(new FindReplaceState());
	private readonly matchCase: Button;
	private readonly wholeWord: Button;
	private readonly regex: Button;
	private readonly previous: Button;
	private readonly next: Button;
	private readonly screen: XtermTerminal;
	private searchGeneration = 0;
	private invalidRegex = false;

	constructor(
		instance: ITerminalInstance,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this.screen = instance.xterm!;
		const document = this.screen.element.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-terminal-find';
		this.domNode.hidden = true;
		this.domNode.setAttribute('aria-label', localize('terminal.find.label', 'Find in terminal'));
		this.screen.element.append(this.domNode);
		this._register(toDisposable(() => {
			this.searchGeneration++;
			if (!this.screen.isDisposed) { this.screen.clearSearchDecorations(); }
			this.domNode.remove();
		}));
		const scope = this._register(contextKeys.createScoped(this.domNode));
		const focused = TerminalContextKeys.findFocus.bindTo(scope);
		const visible = TerminalContextKeys.findVisible.bindTo(contextKeys);
		this._register(addDisposableListener(this.domNode, 'focusin', () => focused.set(true)));
		this._register(addDisposableListener(this.domNode, 'focusout', event => {
			if (!event.relatedTarget || !this.domNode.contains(event.relatedTarget as Node)) { focused.set(false); }
		}));
		this._register(this.state.onFindReplaceStateChange(() => {
			visible.set(this.state.isRevealed);
			this.domNode.hidden = !this.state.isRevealed;
			this.input.value = this.state.searchString;
			this.matchCase.checked = this.state.matchCase;
			this.wholeWord.checked = this.state.wholeWord;
			this.regex.checked = this.state.isRegex;
			if (this.state.isRevealed) { this.findFirst(); }
		}));
		const queryRow = h(document, 'div');
		queryRow.className = 'ash-terminal-find-query';
		this.domNode.append(queryRow);
		this.input = this._register(new InputBox(queryRow, {
			ariaLabel: localize('terminal.find.input', 'Find'),
			placeholder: localize('terminal.find.input', 'Find'),
			presentation: 'compact',
		}));
		this.resultDomNode = h(document, 'span');
		this.resultDomNode.className = 'ash-terminal-find-result';
		this.resultDomNode.setAttribute('role', 'status');
		this.resultDomNode.setAttribute('aria-live', 'polite');
		queryRow.append(this.resultDomNode);
		const controls = h(document, 'div');
		controls.className = 'ash-terminal-find-controls';
		this.domNode.append(controls);
		this.matchCase = this._register(new Button(controls, {
			label: localize('terminal.find.case', 'Match case'),
			size: 'small',
			checked: false,
			onClick: () => this.changeState({ matchCase: !this.state.matchCase }),
		}));
		this.wholeWord = this._register(new Button(controls, {
			label: localize('terminal.find.word', 'Whole word'),
			size: 'small',
			checked: false,
			onClick: () => this.changeState({ wholeWord: !this.state.wholeWord }),
		}));
		this.regex = this._register(new Button(controls, {
			label: localize('terminal.find.regex', 'Regular expression'),
			size: 'small',
			checked: false,
			onClick: () => this.changeState({ isRegex: !this.state.isRegex }),
		}));
		this.previous = this._register(new Button(controls, {
			label: localize('terminal.find.previous', 'Previous match'),
			icon: Lxicon.chevronUp,
			iconOnly: true,
			size: 'small',
			onClick: () => this.find(true),
		}));
		this.next = this._register(new Button(controls, {
			label: localize('terminal.find.next', 'Next match'),
			icon: Lxicon.chevronDown,
			iconOnly: true,
			size: 'small',
			onClick: () => this.find(false),
		}));
		this._register(new Button(controls, {
			label: localize('terminal.find.close', 'Close find'),
			icon: Lxicon.close,
			iconOnly: true,
			size: 'small',
			onClick: () => this.hide(),
		}));
		this._register(this.input.onDidChange(searchString => this.changeState({ searchString })));
		this._register(this.input.onDidFocus(() => {
			if (this.accessibility.isScreenReaderOptimized()) {
				const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Find);
				if (hint) { this.accessibility.status(hint); }
			}
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.isComposing || event.keyCode === 229) { return; }
			if (event.key === 'Escape') { stopEvent(event); this.hide(); }
			else if (event.key === 'Enter' && event.target === this.input.inputElement) { stopEvent(event); this.find(event.shiftKey); }
		}));
		this._register(this.screen.onDidChangeFindResults(() => this.updateResultCount()));
		this.updateResultCount();
	}

	public getDomNode(): HTMLElement { return this.domNode; }
	public getFindInputDomNode(): HTMLInputElement { return this.input.inputElement; }
	public isVisible(): boolean { return this.state.isRevealed; }
	public changeState(state: INewFindReplaceState): void { this.state.change(state, false); }

	public reveal(initialInput?: string): void {
		this.show(initialInput);
		this.input.focus();
		this.input.select();
	}

	public show(initialInput?: string): void {
		this.changeState({ isRevealed: true, searchString: initialInput ?? this.state.searchString });
	}

	public hide(): void {
		this.searchGeneration++;
		this.changeState({ isRevealed: false });
		this.screen.clearSearchDecorations();
		this.screen.focus();
	}

	public findFirst(): void { this.find(false, true); }

	public find(previous: boolean, update = false): void {
		if (!this.state.isRevealed || this.isDisposed) { return; }
		const generation = ++this.searchGeneration;
		this.invalidRegex = false;
		try {
			if (this.state.isRegex) { new RegExp(this.state.searchString); }
		} catch {
			this.invalidRegex = true;
		}
		this.input.inputElement.setAttribute('aria-invalid', String(this.invalidRegex));
		this.domNode.classList.toggle('invalid', this.invalidRegex);
		if (!this.state.searchString || this.invalidRegex) {
			this.screen.clearSearchDecorations();
			this.updateResultCount();
			return;
		}
		const options: ISearchOptions = { regex: this.state.isRegex, wholeWord: this.state.wholeWord, caseSensitive: this.state.matchCase, incremental: update };
		const result = previous ? this.screen.findPrevious(this.state.searchString, options) : this.screen.findNext(this.state.searchString, options);
		void result.then(() => {
			if (!this.isDisposed && generation === this.searchGeneration) { this.updateResultCount(); }
		}).catch(error => {
			if (!isCancellationError(error)) { onUnexpectedError(error); }
		});
	}

	public updateResultCount(): void {
		const result = this.screen.findResult;
		let message = localize('terminal.find.empty', 'Enter a search term');
		if (this.invalidRegex) { message = localize('terminal.find.invalid', 'Invalid regular expression'); }
		else if (this.state.searchString) {
			if (!result?.resultCount) { message = localize('terminal.find.noResults', 'No results'); }
			else if (result.resultIndex < 0) { message = localize('terminal.find.limit', 'More than {0} matches', 1000); }
			else { message = localize('terminal.find.results', '{0} of {1}', result.resultIndex + 1, result.resultCount); }
		}
		this.resultDomNode.textContent = message;
		this.previous.enabled = this.next.enabled = !this.invalidRegex && !!result?.resultCount && !!this.state.searchString;
	}
}
