import './findWidget.css';
import '../../../../base/browser/ui/sash/sash.css';
import { addDisposableListener, h, stopEvent } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { type IHoverLifecycleOptions } from '../../../../base/browser/ui/hover/hover.js';
import { Sash, SashState } from '../../../../base/browser/ui/sash/sash.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { Icon } from '../../../../base/common/icon.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextScopedFindInput, ContextScopedReplaceInput } from '../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { showHistoryKeybindingHint } from '../../../../platform/history/browser/historyWidgetKeybindingHint.js';
import { type IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { type ICodeEditor, type IOverlayWidget, type IOverlayWidgetPosition, OverlayWidgetPositionPreference, type IViewZone } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { CONTEXT_FIND_INPUT_FOCUSED, CONTEXT_FIND_WIDGET_FOCUSED, CONTEXT_REPLACE_INPUT_FOCUSED, MATCHES_LIMIT } from './findModel.js';
import { type FindModelBoundToEditorModel } from './findModel.js';
import { FindReplaceState, type FindReplaceStateChangedEvent } from './findState.js';
import { type FindWidgetSearchHistory } from './findWidgetSearchHistory.js';
import { type ReplaceWidgetHistory } from './replaceWidgetHistory.js';

export interface IFindController {
	replace(): boolean | void;
	replaceAll(): boolean | void;
	getGlobalBufferTerm(): Promise<string>;
}

interface FindWidgetActions extends IFindController {
	moveToNextMatch(): boolean;
	moveToPrevMatch(): boolean;
	closeFindWidget(): void;
	toggleSearchScope(): void;
	isSearchScopeAvailable(): boolean;
}

const iconSvg = (path: string): string =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" ` +
	`fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
	`<path d="${path}"/></svg>`;
export const findSelectionIcon = registerIcon('find-selection', () => iconSvg('M3 3h3M3 3v3M13 3h-3M13 3v3M3 13h3M3 13v-3M13 13h-3M13 13v-3'), 'Search only in the selection');
export const findReplaceIcon = registerIcon('find-replace', () => iconSvg('M3 5h9l-2-2M12 5l-2 2M13 11H4l2-2M4 11l2 2'), 'Replace the current match');
export const findReplaceAllIcon = registerIcon('find-replace-all', () => iconSvg('M3 4h9l-2-2M12 4l-2 2M13 9H4l2-2M4 9l2 2M3 13h10'), 'Replace all matches');
export const findPreviousMatchIcon = registerIcon('find-previous-match', () => iconSvg('M8 13V3M4 7l4-4 4 4'), 'Go to the previous match');
export const findNextMatchIcon = registerIcon('find-next-match', () => iconSvg('M8 3v10M4 9l4 4 4-4'), 'Go to the next match');

export const NLS_MATCHES_LOCATION = localize('label.matchesLocation', '{0} of {1}');
export const NLS_NO_RESULTS = localize('label.noResults', 'No results');

const FIND_WIDGET_INITIAL_WIDTH = 480;
const FIND_WIDGET_EDGE_SPACE = 24;

/** Keeps text below the find overlay when extra top space is requested. */
export class FindWidgetViewZone implements IViewZone {
	public readonly suppressMouseDown = false;
	public readonly domNode: HTMLElement;
	public heightInPx = 33;
	constructor(public readonly afterLineNumber: number, ownerDocument: Document = document) {
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-find-view-zone';
	}
}

export interface ISimpleButtonOpts {
	readonly label: string;
	readonly className?: string;
	readonly icon?: Icon;
	readonly hoverLifecycleOptions?: IHoverLifecycleOptions;
	readonly onTrigger: () => void;
	readonly onKeyDown?: (event: KeyboardEvent) => void;
}

/** An HTML button with the focus and enabled controls used by the find widget. */
export class SimpleButton extends Disposable {
	public readonly domNode: HTMLButtonElement;
	constructor(options: ISimpleButtonOpts, hoverService: IHoverService, ownerDocument: Document = document) {
		super();
		this.domNode = h(ownerDocument, 'button');
		this.domNode.type = 'button';
		this.domNode.className = `stanza-editor-find-button${options.className ? ` ${options.className}` : ''}`;
		this.domNode.setAttribute('aria-label', options.label);
		if (options.icon) appendIcon(options.icon, this.domNode);
		this._register(hoverService.setupHover({
			target: this.domNode,
			content: options.label,
			groupId: options.hoverLifecycleOptions?.groupId,
			delay: options.hoverLifecycleOptions?.reducedDelay ? 'reduced' : 'standard',
			setupKeyboardEvents: options.hoverLifecycleOptions?.setupKeyboardEvents,
		}));
		this._register(addDisposableListener(this.domNode, 'click', options.onTrigger));
		if (options.onKeyDown) this._register(addDisposableListener(this.domNode, 'keydown', options.onKeyDown));
	}
	public isEnabled(): boolean { return !this.domNode.disabled; }
	public focus(): void { this.domNode.focus(); }
	public setEnabled(enabled: boolean): void { this.domNode.disabled = !enabled; }
	public setExpanded(expanded: boolean): void { this.domNode.setAttribute('aria-expanded', String(expanded)); }
}

/** Owns find/replace controls, focus, and accessible match feedback. */
export class FindWidget extends Disposable implements IOverlayWidget {
	private readonly root: HTMLDivElement;
	private readonly resizeSash: Sash;
	private requestedWidth = FIND_WIDGET_INITIAL_WIDTH;
	private displayedWidth = 0;
	private dragStartWidth = 0;
	private readonly findInput: HTMLInputElement;
	private readonly replaceInput: HTMLInputElement;
	private readonly findControl: ContextScopedFindInput;
	private readonly replaceControl: ContextScopedReplaceInput;
	private readonly resultLabel: HTMLSpanElement;
	private readonly replaceRow: HTMLDivElement;
	private readonly replaceToggle: SimpleButton;
	private readonly matchCaseButton: SimpleButton;
	private readonly wholeWordButton: SimpleButton;
	private readonly regexButton: SimpleButton;
	private readonly preserveCaseButton: SimpleButton;
	private readonly scopeButton: SimpleButton;
	private readonly previousButton: SimpleButton;
	private readonly nextButton: SimpleButton;
	private readonly replaceButton: SimpleButton;
	private readonly replaceAllButton: SimpleButton;
	private lastFocused: HTMLElement | null = null;
	private replaceLastFocused = false;
	private viewZoneId: string | null = null;
	private readonly clearOptionHighlight = this._register(new RunOnceScheduler(() => {
		for (const button of [this.matchCaseButton, this.wholeWordButton, this.regexButton]) button.domNode.classList.remove('find-options-highlight');
	}, 2000));
	private readonly widgetFocused;
	private readonly findFocused;
	private readonly replaceFocused;

	constructor(
		private readonly editor: ICodeEditor,
		private readonly controller: FindWidgetActions,
		private readonly state: FindReplaceState,
		private readonly model: FindModelBoundToEditorModel,
		private readonly hoverService: IHoverService,
		keybindingService: IKeybindingService,
		searchHistory?: FindWidgetSearchHistory,
		replaceHistory?: ReplaceWidgetHistory,
	) {
		super();
		const contextKeys = editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
		const instantiationService = editor.invokeWithinContext(accessor => accessor.get(IInstantiationService));
		this.widgetFocused = CONTEXT_FIND_WIDGET_FOCUSED.bindTo(contextKeys);
		this.findFocused = CONTEXT_FIND_INPUT_FOCUSED.bindTo(contextKeys);
		this.replaceFocused = CONTEXT_REPLACE_INPUT_FOCUSED.bindTo(contextKeys);
		const ownerDocument = editor.getContainerDomNode().ownerDocument;
		this.root = h(ownerDocument, 'div');
		this.root.className = 'stanza-editor-find-widget';
		this.root.hidden = true;
		this.root.setAttribute('role', 'dialog');
		this.root.setAttribute('aria-label', localize('label.findDialog', 'Find and replace'));

		const findRow = h(ownerDocument, 'div');
		findRow.className = 'stanza-editor-find-row';
		this.replaceToggle = this.button(
			ownerDocument,
			localize('label.toggleReplace', 'Toggle replace'),
			'›',
			() => this.state.change({ isReplaceRevealed: !this.state.isReplaceRevealed }, false),
		);
		this.replaceToggle.domNode.classList.add('stanza-editor-find-replace-toggle');
		const findLabel = localize('label.find', 'Find');
		this.findControl = this._register(instantiationService.createInstance(ContextScopedFindInput, findRow, {
			label: findLabel,
			history: searchHistory,
			showHistoryHint: () => showHistoryKeybindingHint(keybindingService, contextKeys.getContext(this.findInput)),
		}));
		this.findInput = this.findControl.inputBox.inputElement;
		this.findControl.domNode.classList.add('stanza-editor-find-input-box');
		this.findInput.classList.add('stanza-editor-find-input');
		this.resultLabel = h(ownerDocument, 'span');
		this.resultLabel.className = 'stanza-editor-find-result';
		this.resultLabel.setAttribute('aria-live', 'polite');
		this.matchCaseButton = this.toggle(ownerDocument, localize('label.matchCase', 'Match case'), 'Aa', () => this.state.change({ matchCase: !this.state.matchCase }, true));
		this.wholeWordButton = this.toggle(ownerDocument, localize('label.wholeWord', 'Match whole word'), 'W', () => this.state.change({ wholeWord: !this.state.wholeWord }, true));
		this.regexButton = this.toggle(ownerDocument, localize('label.regex', 'Use regular expression'), '.*', () => this.state.change({ isRegex: !this.state.isRegex }, true));
		this.scopeButton = this.toggle(ownerDocument, localize('label.findInSelection', 'Find in selection'), '', () => this.controller.toggleSearchScope(), findSelectionIcon);
		this.previousButton = this.button(ownerDocument, localize('label.previousMatch', 'Previous match'), '', () => this.controller.moveToPrevMatch(), findPreviousMatchIcon);
		this.nextButton = this.button(ownerDocument, localize('label.nextMatch', 'Next match'), '', () => this.controller.moveToNextMatch(), findNextMatchIcon);
		const close = this.button(ownerDocument, localize('label.closeFind', 'Close find'), '×', () => this.controller.closeFindWidget());
		findRow.append(
			this.replaceToggle.domNode, this.findControl.domNode, this.resultLabel,
			this.matchCaseButton.domNode, this.wholeWordButton.domNode, this.regexButton.domNode,
			this.scopeButton.domNode, this.previousButton.domNode, this.nextButton.domNode, close.domNode,
		);

		this.replaceRow = h(ownerDocument, 'div');
		this.replaceRow.className = 'stanza-editor-replace-row';
		this.replaceRow.hidden = true;
		const spacer = h(ownerDocument, 'span');
		spacer.className = 'stanza-editor-replace-spacer';
		const replaceLabel = localize('label.replace', 'Replace');
		this.replaceControl = this._register(instantiationService.createInstance(ContextScopedReplaceInput, this.replaceRow, {
			label: replaceLabel,
			history: replaceHistory,
			showHistoryHint: () => showHistoryKeybindingHint(keybindingService, contextKeys.getContext(this.replaceInput)),
		}));
		this.replaceInput = this.replaceControl.inputBox.inputElement;
		this.replaceControl.domNode.classList.add('stanza-editor-find-input-box');
		this.replaceInput.classList.add('stanza-editor-find-input');
		this.preserveCaseButton = this.toggle(
			ownerDocument, localize('label.preserveCase', 'Preserve case'), 'AB',
			() => this.state.change({ preserveCase: !this.state.preserveCase }, false),
		);
		this.replaceButton = this.button(
			ownerDocument, localize('label.replaceOne', 'Replace current match'),
			localize('label.replaceButton', 'Replace'), () => this.controller.replace(), findReplaceIcon,
		);
		this.replaceAllButton = this.button(
			ownerDocument, localize('label.replaceAll', 'Replace all matches'),
			localize('label.replaceAllButton', 'All'), () => this.controller.replaceAll(), findReplaceAllIcon,
		);
		this.replaceRow.append(spacer, this.replaceControl.domNode, this.preserveCaseButton.domNode, this.replaceButton.domNode, this.replaceAllButton.domNode);
		this.root.append(findRow, this.replaceRow);
		this.resizeSash = this._register(new Sash(this.root, 'vertical'));
		this.resizeSash.element.setAttribute('aria-label', localize('label.resizeFindWidget', 'Resize find widget'));
		this.resizeSash.element.setAttribute(
			'aria-description',
			localize('label.resizeFindWidgetHint', 'Use the left and right arrow keys to resize. Double-click to switch between default and maximum width.'),
		);
		this._register(this.resizeSash.onDidStart(() => { this.dragStartWidth = this.displayedWidth; }));
		this._register(this.resizeSash.onDidChange(event => {
			this.requestedWidth = this.dragStartWidth - event.delta;
			this.layout();
		}));
		this._register(this.resizeSash.onDidReset(() => {
			const maximumWidth = this.getMaximumWidth();
			this.requestedWidth = this.displayedWidth === FIND_WIDGET_INITIAL_WIDTH ? maximumWidth : FIND_WIDGET_INITIAL_WIDTH;
			this.layout();
		}));

		this._register(this.findControl.inputBox.onDidChange(value => this.state.change({ searchString: value }, true)));
		this._register(this.replaceControl.inputBox.onDidChange(value => this.state.change({ replaceString: value }, false)));
		this._register(addDisposableListener(this.root, 'keydown', event => this.onKeyDown(event)));
		this._register(addDisposableListener(this.root, 'mousedown', event => {
			if (event.target !== this.findInput && event.target !== this.replaceInput) event.preventDefault();
		}));
		this._register(addDisposableListener(this.root, 'focusin', event => this.onFocus(event)));
		this._register(addDisposableListener(this.root, 'focusout', event => this.onBlur(event)));
		this._register(this.state.onFindReplaceStateChange(event => this.onStateChange(event)));
		this._register(editor.onDidChangeConfiguration(event => {
			if (!event.hasChanged(EditorOption.readOnly)) return;
			if (editor.getOption(EditorOption.readOnly)) {
				const replaceFocused = this.replaceRow.contains(this.root.ownerDocument.activeElement);
				state.change({ isReplaceRevealed: false }, false);
				if (replaceFocused) this.focusFindInput();
			}
			this.onStateChange({});
		}));
		this._register(editor.onDidLayoutChange(() => this.layout()));
		editor.addOverlayWidget(this);
		this._register(toDisposable(() => editor.removeOverlayWidget(this)));
		this.onStateChange({} as FindReplaceStateChangedEvent);
	}

	public getId(): string { return `${this.editor.getId()}.findWidget`; }
	public override dispose(): void {
		if (this.viewZoneId) {
			const id = this.viewZoneId;
			this.editor.changeViewZones(accessor => accessor.removeZone(id));
			this.viewZoneId = null;
		}
		super.dispose();
	}
	public getDomNode(): HTMLElement { return this.root; }
	/** The handle follows the overlay's left edge in its own coordinate system. */
	public getVerticalSashLeft(_sash: Sash): number { return 0; }
	public getPosition(): IOverlayWidgetPosition | null {
		return this.state.isRevealed ? { preference: OverlayWidgetPositionPreference.TOP_RIGHT_CORNER } : null;
	}
	public getViewState(): { widgetViewZoneVisible: boolean; scrollTop: number } {
		const scrollTop = this.editor.getScrollTop();
		return { widgetViewZoneVisible: this.viewZoneId !== null && scrollTop < 33, scrollTop };
	}
	public setViewState(viewState?: { widgetViewZoneVisible: boolean; scrollTop: number }): void {
		if (!viewState?.widgetViewZoneVisible || !this.state.isRevealed) return;
		this.updateViewZone();
		this.editor.setScrollTop(viewState.scrollTop);
	}
	public get lastFocusedInputWasReplace(): boolean { return this.replaceLastFocused; }
	public get lastFocusedElement(): HTMLElement | null { return this.lastFocused; }
	public focusLastElement(): void { (this.lastFocused ?? this.findInput).focus({ preventScroll: true }); }
	public focusFindInput(): void { this.findInput.focus({ preventScroll: true }); this.findInput.select(); }
	public focusReplaceInput(): void { this.replaceInput.focus({ preventScroll: true }); this.replaceInput.select(); }
	public recordReplaceHistory(): void { this.replaceControl.inputBox.addToHistory(); }
	public isFindInputFocused(): boolean { return this.root.ownerDocument.activeElement === this.findInput; }
	public highlightFindOptions(): void {
		for (const button of [this.matchCaseButton, this.wholeWordButton, this.regexButton]) button.domNode.classList.add('find-options-highlight');
		this.clearOptionHighlight.schedule();
	}
	public updateSearchScopeAvailability(): void { this.scopeButton.setEnabled(this.state.searchScope !== null || this.controller.isSearchScopeAvailable()); }

	private button(ownerDocument: Document, label: string, text: string, onTrigger: () => void, icon?: Icon): SimpleButton {
		const button = this._register(new SimpleButton({
			label,
			onTrigger,
			icon,
			hoverLifecycleOptions: { groupId: 'find-widget' },
		}, this.hoverService, ownerDocument));
		if (text) button.domNode.append(ownerDocument.createTextNode(text));
		return button;
	}
	private toggle(ownerDocument: Document, label: string, text: string, onTrigger: () => void, icon?: Icon): SimpleButton {
		const button = this.button(ownerDocument, label, text, onTrigger, icon);
		button.domNode.setAttribute('aria-pressed', 'false');
		return button;
	}
	private onStateChange(event: Partial<FindReplaceStateChangedEvent>): void {
		this.findControl.inputBox.value = this.state.searchString;
		this.replaceControl.inputBox.value = this.state.replaceString;
		this.checked(this.matchCaseButton, this.state.matchCase);
		this.checked(this.wholeWordButton, this.state.wholeWord);
		this.checked(this.regexButton, this.state.isRegex);
		this.checked(this.preserveCaseButton, this.state.preserveCase);
		this.checked(this.scopeButton, this.state.searchScope !== null);
		this.replaceRow.hidden = !this.state.isReplaceRevealed;
		this.replaceToggle.setEnabled(!this.editor.getOption(EditorOption.readOnly));
		this.previousButton.setEnabled(this.state.matchesCount > 0 && this.state.canNavigateBack());
		this.nextButton.setEnabled(this.state.matchesCount > 0 && this.state.canNavigateForward());
		const canReplace = this.state.matchesCount > 0 && !this.editor.getOption(EditorOption.readOnly);
		this.replaceButton.setEnabled(canReplace);
		this.replaceAllButton.setEnabled(canReplace);
		this.replaceToggle.setExpanded(this.state.isReplaceRevealed);
		this.replaceToggle.domNode.textContent = this.state.isReplaceRevealed ? '⌄' : '›';
		this.root.hidden = !this.state.isRevealed;
		this.root.classList.toggle('visible', this.state.isRevealed);
		this.updateViewZone();
		this.updateSearchScopeAvailability();
		this.updateResult();
		if (event.isRevealed || event.isReplaceRevealed) this.layout();
	}
	private checked(button: SimpleButton, value: boolean): void {
		button.domNode.classList.toggle('checked', value);
		button.domNode.setAttribute('aria-pressed', String(value));
	}
	private updateResult(): void {
		const error = this.model.error;
		this.findInput.classList.toggle('invalid', error !== null);
		if (error) {
			this.findInput.setAttribute('aria-invalid', 'true');
			this.findInput.title = error.message;
			this.resultLabel.textContent = localize('label.invalidExpression', 'Invalid expression');
		} else {
			this.findInput.removeAttribute('aria-invalid');
			this.findInput.title = '';
			this.resultLabel.textContent = !this.state.searchString ? '' : !this.state.matchesCount ? NLS_NO_RESULTS
				: localize('label.matchesLocation', '{0} of {1}', this.state.matchesPosition, this.state.matchesCount >= MATCHES_LIMIT ? `${MATCHES_LIMIT}+` : this.state.matchesCount);
		}
	}
	private layout(): void {
		const maximumWidth = this.getMaximumWidth();
		const minimumWidth = Math.min(FIND_WIDGET_INITIAL_WIDTH, maximumWidth);
		this.displayedWidth = Math.min(maximumWidth, Math.max(minimumWidth, this.requestedWidth));
		this.root.style.width = `${this.displayedWidth}px`;
		this.resizeSash.element.style.left = `${this.getVerticalSashLeft(this.resizeSash)}px`;
		if (maximumWidth <= minimumWidth) {
			this.resizeSash.state = SashState.Disabled;
		} else if (this.displayedWidth === minimumWidth) {
			this.resizeSash.state = SashState.AtMaximum;
		} else if (this.displayedWidth === maximumWidth) {
			this.resizeSash.state = SashState.AtMinimum;
		} else {
			this.resizeSash.state = SashState.Enabled;
		}
		this.resizeSash.element.setAttribute('aria-valuemin', String(minimumWidth));
		this.resizeSash.element.setAttribute('aria-valuemax', String(maximumWidth));
		this.resizeSash.element.setAttribute('aria-valuenow', String(this.displayedWidth));
		this.editor.layoutOverlayWidget(this);
	}
	private getMaximumWidth(): number {
		const layout = this.editor.getLayoutInfo();
		return Math.max(0, layout.width - layout.verticalScrollbarWidth - layout.minimap.minimapWidth - FIND_WIDGET_EDGE_SPACE);
	}
	private updateViewZone(): void {
		const shouldShow = this.state.isRevealed && this.editor.getOption(EditorOption.find).addExtraSpaceOnTop;
		if (shouldShow && !this.viewZoneId) {
			this.editor.changeViewZones(accessor => { this.viewZoneId = accessor.addZone(new FindWidgetViewZone(0, this.root.ownerDocument)); });
		} else if (!shouldShow && this.viewZoneId) {
			const id = this.viewZoneId;
			this.editor.changeViewZones(accessor => accessor.removeZone(id));
			this.viewZoneId = null;
		}
	}
	private onKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === 'Escape') { stopEvent(event); this.controller.closeFindWidget(); return; }
		if (event.key.toLowerCase() === 'l' && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			stopEvent(event); this.controller.toggleSearchScope(); return;
		}
		if (event.target === this.findInput && event.key === 'Enter' && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			this.findControl.inputBox.addToHistory();
			if (event.shiftKey) this.controller.moveToPrevMatch(); else this.controller.moveToNextMatch();
		} else if (event.target === this.replaceInput && event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
			stopEvent(event);
			this.controller.replace();
		}
	}
	private onFocus(event: FocusEvent): void {
		const target = event.target;
		if (!(target instanceof this.root.ownerDocument.defaultView!.HTMLElement)) return;
		this.lastFocused = target;
		if (target === this.findInput || target === this.replaceInput) this.replaceLastFocused = target === this.replaceInput;
		this.widgetFocused.set(true);
		this.findFocused.set(target === this.findInput);
		this.replaceFocused.set(target === this.replaceInput);
	}
	private onBlur(event: FocusEvent): void {
		if (event.relatedTarget instanceof this.root.ownerDocument.defaultView!.Node && this.root.contains(event.relatedTarget)) return;
		this.widgetFocused.set(false);
		this.findFocused.set(false);
		this.replaceFocused.set(false);
	}
}
