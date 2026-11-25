import './media/suggest.css';
import { Position } from '../../../common/core/position.js';
import { URI } from '../../../../base/common/uri.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import type { ILanguageService } from '../../../common/languages/language.js';
import { getIconClasses } from '../../../common/services/getIconClasses.js';
import { addDisposableListener, fragment as createFragment, getClientArea, getWindow, h, isElement, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { applyFontInfo } from '../../../browser/config/domFontInfo.js';
import { ContentWidgetPositionPreference, contentWidgetViewportVerticalPadding, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { LanguageCompletionDetailsStatus, LanguageCompletionSessionChangeReason, type LanguageCompletionSessionState, SuggestModel } from './suggestModel.js';
import { LanguageCompletionItemKind, type LanguageCompletionItem } from '../../../common/languages.js';
import { type ViewController } from '../../../browser/view/viewController.js';
import { type View } from '../../../browser/view.js';

let nextCompletionWidgetId = 1;
const minimumSpaceToPreferAbove = 150;

/** Displays one completion session in Stanza-owned browser UI. */
export class SuggestWidget extends Disposable implements IContentWidget {
	readonly allowEditorOverflow = true;
	readonly element: HTMLDivElement;
	private readonly widgetId: string;
	private readonly list: List<LanguageCompletionItem>;
	private preferAbove = false;
	private revealActiveItem = false;
	private anchorElement: HTMLElement | undefined;
	private readonly anchorResize = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly editor: ICodeEditor,
		private readonly view: ViewController,
		private readonly viewport: View,
		private readonly session: SuggestModel,
		private readonly languageService: ILanguageService,
	) {
		super();
		try {
			if (
				viewport.textModel !== editor.getModel() ||
				viewport.textModel !== session.textModel
			) {
				throw new TypeError('Stanza completion widget dependencies must share one text model');
			}
		} catch (error) {
			this.dispose();
			throw error;
		}
		this.widgetId = `stanza-completion-${nextCompletionWidgetId++}`;
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.id = this.widgetId;
		this.element.className = 'stanza-editor-completion';
		this.element.hidden = true;
		this.list = this._register(new List<LanguageCompletionItem>(this.element, {
			scrolling: 'managed',
			sizing: 'fit-content',
			// The editor keeps DOM focus and SuggestModel owns navigation and acceptance.
			mouseSupport: false,
			scrollbarTabStop: false,
			renderItem: (item, index, row) => this.renderItem(item, index, row),
		}));
		this.list.domNode.classList.add('stanza-editor-completion-list');
		applyFontInfo(this.element, editor.getOption(EditorOption.fontInfo));
		this.editor.addContentWidget(this);
		this._register(toDisposable(() => {
			this.editor.removeContentWidget(this);
			this.updateAria(undefined);
		}));
		this._register(session.onDidChange(({ reason }) => this.render(reason)));
		this._register(viewport.onDidChangeLayout(() => this.layout()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.fontInfo)) {
				applyFontInfo(this.element, editor.getOption(EditorOption.fontInfo));
				this.layout();
			}
		}));
		this._register(addDisposableListener(getWindow(this.element), 'resize', () => this.layout()));
		this._register(addDisposableListener(view.element, 'keydown', event => this.handleKeydown(event)));
		this._register(addDisposableListener(view.element, 'blur', () => session.cancel()));
		this._register(addDisposableListener(view.element, 'compositionstart', () => session.cancel()));
		this._register(addDisposableListener<MouseEvent>(this.list.element, 'mousemove', event => {
			if (event.buttons !== 0) return;
			const index = this.readOptionIndex(event);
			if (index !== undefined) session.selectIndex(index);
		}));
		this._register(addDisposableListener<MouseEvent>(this.element, 'mousedown', event => {
			const index = this.readOptionIndex(event);
			if (index === undefined || event.button !== 0) return;
			stopEvent(event);
			session.selectIndex(index);
			this.accept();
		}));
		this.render();
	}

	get visible(): boolean {
		return this.element.classList.contains('visible');
	}

	getId(): string {
		return this.widgetId;
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	getPosition(): IContentWidgetPosition | null {
		const state = this.readState();
		if (!state) return null;
		const above = this.prefersAbove(this.getAnchor(state)?.top ?? 0);
		const first = above ? ContentWidgetPositionPreference.ABOVE : ContentWidgetPositionPreference.BELOW;
		const second = above ? ContentWidgetPositionPreference.BELOW : ContentWidgetPositionPreference.ABOVE;
		return { position: state.position, preference: [first, second], anchorElement: this.anchorElement };
	}

	beforeRender(): null {
		const state = this.readState();
		const anchor = state && this.getAnchor(state);
		if (anchor) {
			const viewportHeight = getClientArea(this.element.ownerDocument.body).height;
			const spaceAbove = anchor.top - contentWidgetViewportVerticalPadding;
			const spaceBelow = viewportHeight - contentWidgetViewportVerticalPadding - anchor.top - anchor.height;
			const availableHeight = this.prefersAbove(anchor.top) ? spaceAbove : Math.max(spaceAbove, spaceBelow);
			this.element.style.setProperty('--stanza-suggest-available-height', `${Math.max(0, Math.floor(availableHeight))}px`);
		}
		return null;
	}

	afterRender(position: ContentWidgetPositionPreference | null): void {
		if (position === null || !this.revealActiveItem) return;
		this.revealActiveItem = false;
		this.list.reveal(this.list.activeIndex);
	}

	forceRenderingAbove(): void {
		if (this.preferAbove) return;
		this.preferAbove = true;
		this.layout();
	}

	setAnchorElement(anchor: HTMLElement): void {
		this.anchorElement = anchor;
		this.anchorResize.value = observeResize(anchor, () => this.layout(), { box: 'border-box' });
		this.layout();
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.isComposing ||
			!this.readState() ||
			event.ctrlKey ||
			event.altKey ||
			event.metaKey
		) {
			return;
		}
		switch (event.key) {
			case 'ArrowDown':
				stopEvent(event);
				this.session.selectNext();
				return;
			case 'ArrowUp':
				stopEvent(event);
				this.session.selectPrevious();
				return;
			case 'Enter':
				if (event.shiftKey) return;
				if (this.readState()?.selectedIndex === -1) return;
				stopEvent(event);
				this.accept();
				return;
			case 'Tab':
				if (event.shiftKey || this.editor.getOption(EditorOption.tabFocusMode)) return;
				if (this.readState()?.selectedIndex === -1) return;
				stopEvent(event);
				this.accept();
				return;
			case 'Escape':
				stopEvent(event);
				this.session.cancel();
				return;
		}
	}

	private accept(): void {
		if (!this.session.acceptSelected()) return;
		const position = this.editor.getPosition();
		if (position) this.viewport.revealPosition(Position.lift(position));
		this.viewport.focus();
	}

	private render(reason?: LanguageCompletionSessionChangeReason): void {
		const state = this.readState();
		if (!state) {
			if (this.list.items.length) this.list.items = [];
			this.element.classList.remove('visible');
			this.element.hidden = true;
			this.updateAria(undefined);
			this.editor.layoutContentWidget(this);
			return;
		}
		const previousIndex = this.list.activeIndex;
		if (reason !== LanguageCompletionSessionChangeReason.Focus && reason !== LanguageCompletionSessionChangeReason.Details) {
			this.list.items = state.items;
		}
		this.list.setActiveIndex(state.selectedIndex, undefined, { reveal: false });
		this.list.setSelection(state.selectedIndex < 0 ? [] : [state.selectedIndex]);
		if (reason === LanguageCompletionSessionChangeReason.Focus) this.list.rerender(previousIndex);
		if (reason === LanguageCompletionSessionChangeReason.Focus || reason === LanguageCompletionSessionChangeReason.Details) {
			this.list.rerender(state.selectedIndex);
		}
		this.element.hidden = false;
		this.element.classList.add('visible');
		this.updateAria(state);
		this.layout();
	}

	private renderItem(item: LanguageCompletionItem, index: number, row: HTMLDivElement): DocumentFragment {
		const state = this.readState();
		const ownerDocument = row.ownerDocument;
		const fragment = createFragment(ownerDocument);
		const group = item.group?.label;
		if (group && group !== state?.items[index - 1]?.group?.label) {
			const heading = h(ownerDocument, 'div', {
				className: 'stanza-editor-completion-group-heading',
				attributes: { 'aria-hidden': 'true' },
			});
			heading.textContent = group;
			fragment.append(heading);
		}
		row.classList.add('stanza-editor-completion-option');
		row.dataset.completionIndex = String(index);
		if (group) row.setAttribute('aria-description', group);
		else row.removeAttribute('aria-description');
		const details = index === state?.selectedIndex ? state.details : undefined;
		const resolving = !!details && state?.detailsStatus === LanguageCompletionDetailsStatus.Loading;
		row.classList.toggle('resolving', resolving);
		if (resolving) row.setAttribute('aria-busy', 'true');
		else row.removeAttribute('aria-busy');

		const contents = h(ownerDocument, 'div', { className: 'stanza-editor-completion-item' });
		const kind = h(ownerDocument, 'span', { className: 'stanza-editor-completion-kind', attributes: { 'aria-hidden': 'true' } });
		kind.classList.toggle('function', item.kind === LanguageCompletionItemKind.Function);
		kind.textContent = completionKindLabel(item.kind);
		if (item.kind === LanguageCompletionItemKind.File || item.kind === LanguageCompletionItemKind.Folder) {
			const fileKind = item.kind === LanguageCompletionItemKind.File ? FileKind.File : FileKind.Directory;
			const resource = URI.parse(`fake:///${encodeURIComponent(item.label)}`);
			const detail = item.detail ? URI.parse(`fake:///${encodeURIComponent(item.detail)}`) : undefined;
			const labelClasses = getIconClasses(undefined, this.languageService, resource, fileKind);
			const detailClasses = detail ? getIconClasses(undefined, this.languageService, detail, fileKind) : [];
			const iconClasses = fileKind === FileKind.File && detailClasses.length > labelClasses.length
				? detailClasses : labelClasses;
			kind.classList.add('ash-themed-file-icon', ...iconClasses, ...(fileKind === FileKind.Directory ? detailClasses : []));
		}
		const label = h(ownerDocument, 'span', { className: 'stanza-editor-completion-label' });
		appendHighlightedText(label, item.label, item.labelMatchIndices);
		const detail = h(ownerDocument, 'span', { className: 'stanza-editor-completion-detail' });
		const detailText = (details ? details.detail : item.detail) ?? '';
		appendHighlightedText(detail, detailText, detailText === item.detail ? item.detailMatchIndices : undefined);
		contents.append(kind, label, detail);
		if (details?.documentation !== undefined) {
			const documentation = h(ownerDocument, 'span', { className: 'stanza-editor-completion-documentation' });
			documentation.textContent = details.documentation;
			contents.append(documentation);
		}
		fragment.append(contents);
		return fragment;
	}

	private layout(): void {
		if (!this.visible) return;
		// Background editor renders must not pull the list back while it is scrolled by hand.
		this.revealActiveItem = true;
		this.editor.layoutContentWidget(this);
	}

	private getAnchor(state: LanguageCompletionSessionState): { top: number; height: number; } | undefined {
		if (this.anchorElement) return this.anchorElement.getBoundingClientRect();
		const caret = this.editor.getScrolledVisiblePosition(state.position);
		if (!caret) return undefined;
		const editorTop = this.viewport.domNode.domNode.getBoundingClientRect().top;
		return { top: editorTop + caret.top, height: caret.height };
	}

	private prefersAbove(anchorTop: number): boolean {
		return this.preferAbove && anchorTop > minimumSpaceToPreferAbove;
	}

	private updateAria(state: LanguageCompletionSessionState | undefined): void {
		const listId = this.list.element.id;
		if (state) {
			this.view.element.setAttribute('aria-controls', listId);
		} else if (this.view.element.getAttribute('aria-controls') === listId) {
			this.view.element.removeAttribute('aria-controls');
		}
		const activeDescendant = state ? this.list.row(state.selectedIndex)?.id : undefined;
		this.viewport.setAriaOptions({ activeDescendant });
	}

	private readState(): LanguageCompletionSessionState | undefined {
		try {
			return this.session.state;
		} catch (error) {
			if (error instanceof ReferenceError) return undefined;
			throw error;
		}
	}

	private readOptionIndex(event: MouseEvent): number | undefined {
		const target = event.target;
		if (!isElement(target)) return undefined;
		const option = target.closest('.stanza-editor-completion-item')?.parentElement;
		if (!option || option.parentElement !== this.list.element) return undefined;
		const index = Number(option.dataset.completionIndex);
		return Number.isSafeInteger(index) ? index : undefined;
	}
}

function appendHighlightedText(element: HTMLElement, value: string, indices: readonly number[] | undefined): void {
	if (!indices?.length) {
		element.textContent = value;
		return;
	}
	const characters = [...value];
	const matched = new Set(indices);
	for (let index = 0; index < characters.length; index++) {
		const character = characters[index]!;
		if (matched.has(index)) {
			const strong = h(element.ownerDocument, 'strong');
			strong.textContent = character;
			element.append(strong);
		} else {
			element.append(character);
		}
	}
}

function completionKindLabel(kind: LanguageCompletionItemKind): string {
	switch (kind) {
		case LanguageCompletionItemKind.Text: return 'Text';
		case LanguageCompletionItemKind.Method: return 'Method';
		case LanguageCompletionItemKind.Function: return 'Function';
		case LanguageCompletionItemKind.Constructor: return 'Constructor';
		case LanguageCompletionItemKind.Field: return 'Field';
		case LanguageCompletionItemKind.Variable: return 'Variable';
		case LanguageCompletionItemKind.Class: return 'Class';
		case LanguageCompletionItemKind.Interface: return 'Interface';
		case LanguageCompletionItemKind.Module: return 'Module';
		case LanguageCompletionItemKind.Property: return 'Property';
		case LanguageCompletionItemKind.Unit: return 'Unit';
		case LanguageCompletionItemKind.Value: return 'Value';
		case LanguageCompletionItemKind.Enum: return 'Enum';
		case LanguageCompletionItemKind.Keyword: return 'Keyword';
		case LanguageCompletionItemKind.Snippet: return 'Snippet';
		case LanguageCompletionItemKind.File: return 'File';
		case LanguageCompletionItemKind.Folder: return 'Folder';
		case LanguageCompletionItemKind.Reference: return 'Reference';
		case LanguageCompletionItemKind.TypeParameter: return 'Type';
	}
}
