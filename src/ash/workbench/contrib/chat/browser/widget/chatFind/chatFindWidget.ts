import './chatFindWidget.css';
import { revealMarkdownTableRange } from '../chatContentParts/chatMarkdownTableScrolling.js';
import '../../../common/widget/chatColors.js';
import { addDisposableListener, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import type { Event } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import type { ICodeEditor } from '../../../../../../editor/browser/editorBrowser.js';
import { ICodeEditorService } from '../../../../../../editor/browser/services/codeEditorService.js';
import type { IEditorDecorationsCollection } from '../../../../../../editor/common/editorCommon.js';
import { Range as EditorRange } from '../../../../../../editor/common/core/range.js';
import { localize } from '../../../../../../nls.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { SimpleFindWidget } from '../../../../codeEditor/browser/find/simpleFindWidget.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';
import type { IChatFindController } from '../../chat.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';
import { ChatFindModel, type IChatFindMatch, type IChatFindOptions, MAX_FIND_MATCHES } from './chatFindModel.js';
import { getChatFindHighlightRegistry, type IChatFindHighlightRegistry, type IChatFindHighlightWindow } from './chatFindHighlights.js';

export interface IChatFindHost {
	readonly element: HTMLElement;
	readonly onDidChange: Event<void>;
	getItems(): readonly IChatListItem[];
	getRowElement(id: string): HTMLElement | undefined;
	getViewportAnchorItemId(): string | undefined;
	reveal(id: string, target?: { readonly top: number; readonly bottom: number; }): void;
	focus(): void;
	isVisible(): boolean;
	setFindVisible(visible: boolean): void;
	getHistoryState?(): { readonly loading: boolean; readonly error?: string; } | undefined;
	loadOlderHistory?(): Promise<void>;
}

/** Ranges leave the message DOM, selection, links and inline controls intact. */
export function findMatchRangesInDom(root: HTMLElement, regex: RegExp, limit: number, excludedRoots: readonly HTMLElement[] = []): Range[] {
	const groups: { text: string; nodes: { readonly node: Text; readonly start: number; readonly end: number; }[]; }[] = [];
	let group: typeof groups[number] | undefined;
	const flush = (): void => { group = undefined; };
	const walk = (node: Node): void => {
		if (node.nodeType === 3) {
			if (!node.textContent) { return; }
			if (!group) { group = { text: '', nodes: [] }; groups.push(group); }
			const start = group.text.length;
			group.text += node.textContent;
			group.nodes.push({ node: node as Text, start, end: group.text.length });
			return;
		}
		if (node.nodeType !== 1) { return; }
		const element = node as HTMLElement;
		if (excludedRoots.includes(element) || element.matches('button,input,textarea,svg,script,style,[aria-hidden="true"],[role="toolbar"],.ash-chat-code-block')) { return; }
		if (element.tagName === 'BR') {
			if (group) { group.text += '\n'; }
			return;
		}
		const block = /^(P|PRE|LI|TD|TH|H[1-6]|BLOCKQUOTE|DIV)$/u.test(element.tagName);
		if (block) { flush(); }
		for (const child of element.childNodes) { walk(child); }
		if (block) { flush(); }
	};
	walk(root);
	const ranges: Range[] = [];
	for (const group of groups) {
		regex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while (ranges.length < limit && (match = regex.exec(group.text))) {
			if (!match[0].length) {
				regex.lastIndex += (group.text.codePointAt(regex.lastIndex) ?? 0) > 0xffff ? 2 : 1;
				continue;
			}
			const end = match.index + match[0].length;
			const first = group.nodes.find(node => node.end > match!.index);
			const last = group.nodes.find(node => node.end >= end);
			if (!first || !last) { continue; }
			const range = root.ownerDocument.createRange();
			range.setStart(first.node, Math.max(0, match.index - first.start));
			range.setEnd(last.node, Math.max(0, end - last.start));
			ranges.push(range);
		}
		if (ranges.length >= limit) { break; }
	}
	return ranges;
}

export function openAncestorDisclosures(root: HTMLElement, node: Node): boolean {
	let changed = false;
	for (let parent = node.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
		if (parent.tagName === 'DETAILS' && !(parent as HTMLDetailsElement).open) {
			(parent as HTMLDetailsElement).open = true;
			changed = true;
		}
	}
	return changed;
}

export function computeRevealScrollTop(scrollTop: number, renderHeight: number, top: number, bottom: number): number | undefined {
	if (top >= 0 && bottom <= renderHeight) { return undefined; }
	return Math.max(0, scrollTop + (top < 0 || bottom - top > renderHeight ? top : bottom - renderHeight));
}

/** Shared Find presentation. The host retains message, history and scroll ownership. */
export class ChatFindWidget extends Disposable implements IChatFindController {
	private readonly domNode: HTMLElement;
	private readonly view: SimpleFindWidget;
	private readonly historyButton: Button;
	private readonly toggles = new Map<keyof IChatFindOptions, Button>();
	private readonly model: ChatFindModel;
	private readonly decorations = new Map<ICodeEditor, IEditorDecorationsCollection>();
	private readonly highlights: IChatFindHighlightRegistry;
	private previousFocus: HTMLElement | undefined;
	private lastFocus: HTMLElement | undefined;
	private current: IChatFindMatch | undefined;
	private pendingReveal = false;
	private generation = 0;
	private historyLoading = false;
	private historyError: string | undefined;
	private readonly refresh = this._register(new RunOnceScheduler(() => {
		if (this.visible) { this.model.recompute(); }
	}, 60));
	private readonly searchHistory = this._register(new RunOnceScheduler(() => { void this.loadHistory(); }, 150));

	constructor(
		private readonly host: IChatFindHost,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICodeEditorService private readonly editors: ICodeEditorService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
	) {
		super();
		const document = host.element.ownerDocument;
		this.highlights = getChatFindHighlightRegistry(document.defaultView as IChatFindHighlightWindow);
		this.model = this._register(new ChatFindModel(() => host.getItems(), () => host.getViewportAnchorItemId()));
		this.view = this._register(new SimpleFindWidget(host.element, {
			label: localize('chat.find', 'Find in Chat'),
			placeholder: localize('chat.find.input', 'Find in conversation'),
			previousLabel: localize('chat.find.previous', 'Previous match'),
			nextLabel: localize('chat.find.next', 'Next match'),
			closeLabel: localize('chat.find.close', 'Close Find'),
			onInput: value => {
				if (this.visible && value !== this.model.query) { this.search(value, this.model.options); }
			},
			onNavigate: previous => this.navigate(previous),
			onClose: () => this.hide(),
		}));
		this.domNode = this.view.getDomNode();
		this.domNode.classList.add('ash-chat-find');
		const scope = this._register(contextKeys.createScoped(this.domNode));
		ChatContextKeys.findWidgetFocused.bindTo(scope).set(true);
		const inputFocused = ChatContextKeys.findInputFocused.bindTo(scope);
		for (const [key, icon, label] of [
			['matchCase', Lxicon.caseSensitive, localize('chat.find.case', 'Match case')],
			['wholeWord', Lxicon.wholeWord, localize('chat.find.word', 'Whole word')],
			['isRegex', Lxicon.regex, localize('chat.find.regex', 'Regular expression')],
		] as const) {
			this.toggles.set(key, this._register(new Button(this.view.optionsElement, {
				...defaultButtonStyles, size: 'small', label, title: label, icon, iconOnly: true, checked: false,
				onClick: () => this.changeOptions({ [key]: !this.model.options[key] }),
			})));
		}
		this.historyButton = this._register(new Button(this.domNode, {
			...defaultButtonStyles, size: 'small', label: localize('chat.find.earlier', 'Search earlier messages'),
			onClick: () => { void this.loadHistory(); },
		}));
		this.historyButton.domNode.classList.add('ash-chat-find-history');
		const input = this.view.getFindInputDomNode();
		this._register(addDisposableListener(input, 'focus', () => {
			inputFocused.set(true);
			if (this.accessibility.isScreenReaderOptimized()) {
				const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.Find);
				if (hint) { this.accessibility.status(hint); }
			}
		}));
		this._register(addDisposableListener(input, 'blur', () => inputFocused.set(false)));
		this._register(addDisposableListener(this.domNode, 'focusin', () => {
			const active = document.activeElement;
			if (isHTMLElement(active)) { this.lastFocus = active; }
		}));
		const Resize = document.defaultView?.ResizeObserver;
		if (Resize) {
			const observer = new Resize(() => {
				if (this.visible) { this.pendingReveal = true; this.refresh.schedule(); }
			});
			observer.observe(this.domNode);
			this._register(toDisposable(() => observer.disconnect()));
		}
		this._register(this.model.onDidChange(() => this.update()));
		this._register(host.onDidChange(() => { if (this.visible) { this.refresh.schedule(); } }));
		this._register(toDisposable(() => {
			this.generation++;
			this.clearHighlights();
			host.setFindVisible(false);
		}));
		this.update();
	}

	public get visible(): boolean { return !this.isDisposed && !this.domNode.hidden; }

	public show(seedText?: string, focus = true): void {
		if (this.isDisposed || !this.host.isVisible()) { return; }
		if (!this.visible) {
			const active = this.domNode.ownerDocument.activeElement;
			this.previousFocus = isHTMLElement(active) ? active : undefined;
		}
		this.domNode.hidden = false;
		if (seedText !== undefined) {
			this.view.inputValue = seedText.replace(/\r\n|\r|\n/gu, ' ');
		}
		if (!this.view.isComposing && this.view.inputValue !== this.model.query) {
			this.search(this.view.inputValue, this.model.options);
		} else {
			this.model.recompute();
			this.searchHistory.schedule();
		}
		if (focus) { this.view.focusFindBox(); }
	}

	public hide(): void {
		const focused = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.generation++;
		this.refresh.cancel();
		this.searchHistory.cancel();
		this.historyLoading = false;
		this.historyError = undefined;
		this.domNode.hidden = true;
		this.view.inputValue = this.model.query;
		this.model.suspend();
		this.current = undefined;
		this.pendingReveal = false;
		this.host.setFindVisible(false);
		this.clearHighlights();
		if (focused && this.host.isVisible()) {
			if (this.previousFocus?.isConnected && !this.previousFocus.closest('[hidden]')) { this.previousFocus.focus(); }
			else { this.host.focus(); }
		}
	}

	public next(): void { this.navigate(false); }
	public previous(): void { this.navigate(true); }
	public focus(): void { if (this.visible) { (this.lastFocus?.isConnected ? this.lastFocus : this.view.getFindInputDomNode()).focus(); } }
	public toggleCaseSensitive(): void { this.changeOptions({ matchCase: !this.model.options.matchCase }); }
	public toggleWholeWord(): void { this.changeOptions({ wholeWord: !this.model.options.wholeWord }); }
	public toggleRegex(): void { this.changeOptions({ isRegex: !this.model.options.isRegex }); }

	private changeOptions(options: Partial<IChatFindOptions>): void {
		if (!this.visible) { return; }
		this.search(this.model.query, { ...this.model.options, ...options });
	}

	private navigate(previous: boolean): void {
		if (this.view.isComposing) { return; }
		if (!this.visible) { this.show(undefined, false); }
		if (!this.visible) { return; }
		if (previous) { this.model.previous(); }
		else { this.model.next(); }
	}

	private search(query: string, options: IChatFindOptions): void {
		this.generation++;
		this.historyLoading = false;
		this.historyError = undefined;
		this.model.setQuery(query, options);
		this.searchHistory.schedule();
	}

	private update(): void {
		for (const [key, button] of this.toggles) { button.checked = this.model.options[key]; }
		const invalid = this.model.isInvalidRegex;
		const hasMatches = this.model.matches.length > 0;
		const hasHistory = !!this.host.getHistoryState?.();
		let message = !this.model.query ? ''
			: invalid ? localize('chat.find.invalidRegex', 'Invalid regular expression')
				: !this.model.matches.length ? localize('chat.find.noResults', 'No results')
					: this.model.isTruncated ? localize('chat.find.truncated', '{0} of {1}+ matches', this.model.activeIndex + 1, this.model.matches.length)
						: localize('chat.find.count', '{0} of {1} matches', this.model.activeIndex + 1, this.model.matches.length);
		const canSearchHistory = !!this.model.query && !invalid && hasHistory;
		if (this.historyLoading) { message = localize('chat.find.loading', '{0} · Searching earlier messages…', message); }
		else if (this.historyError) { message = localize('chat.find.historyFailed', '{0} · Earlier history could not be searched: {1}', message, this.historyError); }
		else if (canSearchHistory) { message = localize('chat.find.partial', '{0} · More history available', message); }
		this.view.setResult(message, {
			hasMatches, invalid, detail: invalid || this.historyLoading || !!this.historyError || canSearchHistory,
		});
		this.historyButton.hidden = !canSearchHistory || this.historyLoading;
		if (!this.visible) { return; }
		this.host.setFindVisible(true);
		const active = this.model.activeMatch;
		this.pendingReveal ||= !!active && (active.itemId !== this.current?.itemId || active.partIndex !== this.current?.partIndex || active.start !== this.current?.start);
		this.current = active;
		if (this.pendingReveal && active) { this.host.reveal(active.itemId); }
		this.paint(this.pendingReveal);
	}

	private clearHighlights(): void {
		this.highlights.clear(this);
		for (const [editor, decoration] of this.decorations) { if (editor.getModel()) { decoration.clear(); } }
		this.decorations.clear();
		for (const element of this.host.element.querySelectorAll('.ash-chat-find-active')) { element.classList.remove('ash-chat-find-active'); }
	}

	private paint(reveal: boolean): void {
		this.clearHighlights();
		const pattern = this.model.regex;
		if (!pattern) { return; }
		const ranges: Range[] = [];
		let activeRange: Range | undefined;
		const rows = new Map<string, IChatFindMatch[]>();
		for (const match of this.model.matches) {
			const entries = rows.get(match.itemId) ?? [];
			entries.push(match);
			rows.set(match.itemId, entries);
		}
		const editors = this.editors.listCodeEditors().filter(editor => !!editor.getModel());
		for (const [id, matches] of rows) {
			const row = this.host.getRowElement(id);
			if (!row) { continue; }
			const body = row.querySelector<HTMLElement>('.ash-markdown') ?? row.querySelector<HTMLElement>(':scope > pre');
			const textMatches = matches.filter(match => match.codeBlockIndex === undefined);
			if (body) {
				const found = findMatchRangesInDom(body, pattern, Math.min(MAX_FIND_MATCHES, textMatches.length));
				ranges.push(...found);
				const activeIndex = textMatches.indexOf(this.model.activeMatch!);
				if (activeIndex >= 0) { activeRange = found[activeIndex]; }
			}
			const blocks = [...row.querySelectorAll<HTMLElement>('.ash-chat-code-block')];
			for (const editor of blocks.length ? editors : []) {
				const model = editor.getModel();
				if (!model) { continue; }
				const blockIndex = blocks.findIndex(block => block.contains(editor.getContainerDomNode()));
				if (blockIndex < 0) { continue; }
				const codeMatches = matches.filter(match => match.codeBlockIndex === blockIndex);
				if (!codeMatches.length) { continue; }
				const decorations = editor.createDecorationsCollection(codeMatches.map(match => ({
					range: EditorRange.fromPositions(model.getPositionAt(match.start), model.getPositionAt(match.end)),
					options: { description: 'chat-find', className: match === this.model.activeMatch ? 'ash-chat-find-code-current' : 'ash-chat-find-code-match' },
				})));
				this.decorations.set(editor, decorations);
				const active = codeMatches.find(match => match === this.model.activeMatch);
				if (active && reveal) {
					this.pendingReveal = false;
					const range = EditorRange.fromPositions(model.getPositionAt(active.start), model.getPositionAt(active.end));
					editor.revealRange(range);
					const rect = editor.getContainerDomNode().getBoundingClientRect();
					const position = editor.getScrolledVisiblePosition(range.getStartPosition());
					this.host.reveal(id, { top: rect.top + (position?.top ?? 0), bottom: rect.top + (position?.top ?? 0) + (position?.height ?? 20) });
				}
			}
		}
		this.highlights.setRanges(this, 'ash-chat-find-match', ranges);
		this.highlights.setRanges(this, 'ash-chat-find-current-match', activeRange ? [activeRange] : [], 1);
		if (this.current) {
			const row = this.host.getRowElement(this.current.itemId);
			row?.classList.add('ash-chat-find-active');
			if (activeRange && row && reveal) {
				this.pendingReveal = false;
				openAncestorDisclosures(row, activeRange.startContainer);
				if (typeof activeRange.getBoundingClientRect === 'function') {
					const rect = activeRange.getBoundingClientRect();
					revealMarkdownTableRange(activeRange, rect);
					this.host.reveal(this.current.itemId, rect);
				}
			}
		}
	}

	private async loadHistory(): Promise<void> {
		if (!this.visible || !this.model.query || this.model.isInvalidRegex || !this.host.loadOlderHistory || !this.host.getHistoryState?.()) { return; }
		const generation = ++this.generation;
		this.historyLoading = true;
		this.historyError = undefined;
		this.update();
		try {
			// Keep each admission bounded. Very large histories expose an explicit continuation.
			for (let page = 0; page < 32 && this.host.getHistoryState?.(); page++) {
				if (!this.visible || this.isDisposed || generation !== this.generation) { return; }
				await this.host.loadOlderHistory();
				if (!this.visible || this.isDisposed || generation !== this.generation) { return; }
				const error = this.host.getHistoryState?.()?.error;
				if (error) { this.historyError = error; break; }
				this.model.recompute();
			}
		} catch (error) {
			if (generation === this.generation) { this.historyError = error instanceof Error ? error.message : String(error); }
		} finally {
			if (!this.isDisposed && generation === this.generation) { this.historyLoading = false; this.update(); }
		}
	}
}
