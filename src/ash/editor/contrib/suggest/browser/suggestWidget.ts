import './media/suggest.css';
import { Position } from '../../../common/core/position.js';
import { URI } from '../../../../base/common/uri.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import type { ILanguageService } from '../../../common/languages/language.js';
import { getIconClasses } from '../../../common/services/getIconClasses.js';
import { addDisposableListener, fragment as createFragment, getClientArea, getWindow, h, isElement, reset, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { applyFontInfo } from '../../../browser/config/domFontInfo.js';
import { ContentWidgetPositionPreference, contentWidgetViewportVerticalPadding, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { LanguageCompletionDetailsStatus, type LanguageCompletionSessionState, SuggestModel } from './suggestModel.js';
import { LanguageCompletionItemKind } from '../../../common/languages.js';
import { type ViewController } from '../../../browser/view/viewController.js';
import { type View } from '../../../browser/view.js';

let nextCompletionWidgetId = 1;
const minimumSpaceToPreferAbove = 150;

/** Displays one completion session in Stanza-owned browser UI. */
export class SuggestWidget extends Disposable implements IContentWidget {
	readonly allowEditorOverflow = true;
	readonly element: HTMLDivElement;
	private readonly widgetId: string;
	private preferAbove = false;
	private horizontalAnchor: HTMLElement | undefined;
	private readonly horizontalAnchorResize = this._register(new MutableDisposable<IDisposable>());

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
		this.element.setAttribute('role', 'listbox');
		this.element.hidden = true;
		applyFontInfo(this.element, editor.getOption(EditorOption.fontInfo));
		this.editor.addContentWidget(this);
		this._register(toDisposable(() => {
			this.editor.removeContentWidget(this);
			this.updateAria(undefined);
		}));
		this._register(session.onDidChange(() => this.render()));
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
		return { position: state.position, preference: [first, second], horizontalAnchor: this.horizontalAnchor };
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
		if (position === null) return;
		const selected = this.element.querySelector<HTMLElement>('.stanza-editor-completion-option.focused');
		if (!selected) return;
		const top = selected.offsetTop;
		const bottom = top + selected.offsetHeight;
		const scrollTop = this.element.scrollTop;
		if (top < scrollTop) {
			this.element.scrollTop = top;
		} else if (bottom > scrollTop + this.element.clientHeight) {
			this.element.scrollTop = bottom - this.element.clientHeight;
		}
	}

	forceRenderingAbove(): void {
		if (this.preferAbove) return;
		this.preferAbove = true;
		this.layout();
	}

	setHorizontalAnchor(anchor: HTMLElement): void {
		this.horizontalAnchor = anchor;
		this.horizontalAnchorResize.value = observeResize(anchor, () => this.layout(), { box: 'border-box' });
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
				if (event.shiftKey) return;
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

	private render(): void {
		const state = this.readState();
		if (!state) {
			reset(this.element);
			this.element.classList.remove('visible');
			this.element.hidden = true;
			this.updateAria(undefined);
			this.editor.layoutContentWidget(this);
			return;
		}
		const ownerDocument = this.element.ownerDocument;
		const fragment = createFragment(ownerDocument);
		let group: HTMLElement | undefined;
		for (let index = 0; index < state.items.length; index += 1) {
			const item = state.items[index]!;
			if (item.group?.label !== state.items[index - 1]?.group?.label) {
				group = undefined;
				if (item.group) {
					const heading = h(ownerDocument, 'div', { className: 'stanza-editor-completion-group-heading' });
					heading.setAttribute('aria-hidden', 'true');
					heading.textContent = item.group.label;
					group = h(ownerDocument, 'div', { attributes: { role: 'group', 'aria-label': item.group.label } });
					group.append(heading);
					fragment.append(group);
				}
			}
			const option = h(ownerDocument, 'div');
			const kind = h(ownerDocument, 'span');
			const label = h(ownerDocument, 'span');
			const detail = h(ownerDocument, 'span');
			const documentation = h(ownerDocument, 'span');
			const focused = index === state.selectedIndex;
			const resolving = focused && state.detailsStatus === LanguageCompletionDetailsStatus.Loading;
			option.id = `${this.widgetId}-option-${index}`;
			option.className = 'stanza-editor-completion-option';
			option.classList.toggle('focused', focused);
			option.classList.toggle('resolving', resolving);
			option.dataset.completionIndex = String(index);
			option.setAttribute('role', 'option');
			option.setAttribute('aria-selected', String(focused));
			if (resolving) option.setAttribute('aria-busy', 'true');
			kind.className = 'stanza-editor-completion-kind';
			kind.setAttribute('aria-hidden', 'true');
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
			label.className = 'stanza-editor-completion-label';
			appendHighlightedText(label, item.label, item.labelMatchIndices);
			detail.className = 'stanza-editor-completion-detail';
			const detailText = focused ? state.details.detail ?? '' : item.detail ?? '';
			appendHighlightedText(detail, detailText, detailText === item.detail ? item.detailMatchIndices : undefined);
			option.append(kind, label, detail);
			if (focused && state.details.documentation !== undefined) {
				documentation.className = 'stanza-editor-completion-documentation';
				documentation.textContent = state.details.documentation;
				option.append(documentation);
			}
			(group ?? fragment).append(option);
		}
		reset(this.element, fragment);
		this.element.hidden = false;
		this.element.classList.add('visible');
		this.updateAria(state);
		this.layout();
	}

	private layout(): void {
		if (this.visible) this.editor.layoutContentWidget(this);
	}

	private getAnchor(state: LanguageCompletionSessionState): { top: number; height: number; } | undefined {
		const caret = this.editor.getScrolledVisiblePosition(state.position);
		if (!caret) return undefined;
		const editorTop = this.viewport.domNode.domNode.getBoundingClientRect().top;
		return { top: editorTop + caret.top, height: caret.height };
	}

	private prefersAbove(anchorTop: number): boolean {
		return this.preferAbove && anchorTop > minimumSpaceToPreferAbove;
	}

	private updateAria(state: LanguageCompletionSessionState | undefined): void {
		if (state) {
			this.view.element.setAttribute('aria-controls', this.widgetId);
		} else if (this.view.element.getAttribute('aria-controls') === this.widgetId) {
			this.view.element.removeAttribute('aria-controls');
		}
		const activeDescendant = state && state.selectedIndex >= 0 ? `${this.widgetId}-option-${state.selectedIndex}` : undefined;
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
		const option = target.closest<HTMLElement>('.stanza-editor-completion-option');
		if (!option || !this.element.contains(option)) return undefined;
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
