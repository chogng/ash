import './stickyScroll.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { projectStanzaSemanticTokenLine } from '../../../browser/viewParts/viewLines/viewLine.js';
import { EditorOption, RenderLineNumbersType } from '../../../common/config/editorOptions.js';
import { Position } from '../../../common/core/position.js';
import { CharacterMapping, DomPosition } from '../../../common/viewLayout/viewLineRenderer.js';
import type { TextModel } from '../../../common/model/textModel.js';
import type { EditorFoldingModel } from '../../folding/browser/foldingModel.js';
import { foldingCollapsedIcon, foldingExpandedIcon } from '../../folding/browser/foldingDecorations.js';

export class StickyScrollWidgetState {
	constructor(
		public readonly startLineNumbers: number[],
		public readonly endLineNumbers: number[],
		public readonly lastLineRelativePosition: number,
		public readonly showEndForLine: number | null = null,
	) {}

	public static get Empty(): StickyScrollWidgetState {
		return new StickyScrollWidgetState([], [], 0);
	}
}

interface HeaderRow {
	readonly element: HTMLDivElement;
	readonly button: HTMLButtonElement;
	readonly text: HTMLSpanElement;
	readonly number: HTMLSpanElement;
	readonly folding: HTMLButtonElement;
}

/** Owns retained header buttons; the controller mounts the root and handles navigation. */
export class StickyScrollWidget extends Disposable {
	private readonly domNode: HTMLDivElement;
	private lines: number[] = [];
	private readonly rows = new Map<string, HeaderRow>();
	private readonly characterMappings = new WeakMap<HTMLElement, CharacterMapping>();

	constructor(private readonly editor: ICodeEditor, private readonly model: TextModel) {
		super();
		this.domNode = h(editor.getContainerDomNode().ownerDocument, 'div');
		this.domNode.className = 'stanza-editor-sticky-scroll empty';
		this.domNode.hidden = true;
		this.domNode.setAttribute('role', 'group');
		this.domNode.setAttribute('aria-label', localize('stickyScroll.label', 'Sticky section headers'));
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public getDomNode(): HTMLElement {
		return this.domNode;
	}

	public getCurrentLines(): readonly number[] {
		return this.lines;
	}

	public focusLineWithIndex(index: number): void {
		const button = this.domNode.children.item(index)?.querySelector<HTMLButtonElement>('.stanza-editor-sticky-scroll-item');
		if (!button) {
			return;
		}
		for (const row of this.rows.values()) {
			row.button.tabIndex = row.button === button ? 0 : -1;
		}
		button.focus({ preventScroll: true });
	}

	public getLineIndexFromChildDomNode(node: HTMLElement | null): number | null {
		const row = node?.closest('.stanza-editor-sticky-scroll-row');
		if (!row || row.parentElement !== this.domNode) {
			return null;
		}
		return Array.from(this.domNode.children).indexOf(row);
	}

	public isInFoldingIconDomNode(node: HTMLElement): boolean {
		return node.closest('.stanza-editor-sticky-scroll-folding') !== null && this.getLineIndexFromChildDomNode(node) !== null;
	}

	public getEditorPositionFromNode(node: HTMLElement | null): Position | null {
		const index = this.getLineIndexFromChildDomNode(node);
		if (index === null || !node || node.children.length !== 0) {
			return null;
		}
		const row = this.rows.get(String(this.model.getLineId(this.lines[index]! - 1)))!;
		if (node.parentElement !== row.text) {
			return null;
		}
		const partIndex = Array.from(row.text.children).indexOf(node);
		const column = this.characterMappings.get(row.text)!.getColumn(new DomPosition(partIndex, 0), node.textContent!.length);
		return new Position(Number(row.button.dataset.lineNumber), column);
	}

	public setState(state: StickyScrollWidgetState, foldingModel: EditorFoldingModel): void {
		this.lines = state.startLineNumbers;
		const options = this.editor.getOption(EditorOption.stickyScroll);
		const layout = this.editor.getLayoutInfo();
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const lineNumbers = this.editor.getOption(EditorOption.lineNumbers);
		const currentLine = this.editor.getPosition()!.lineNumber;
		const foldingControls = this.editor.getOption(EditorOption.showFoldingControls);
		this.editor.applyFontInfo(this.domNode);
		this.domNode.classList.toggle('folding-on-hover', foldingControls === 'mouseover');
		this.domNode.style.tabSize = String(this.model.getOptions().tabSize);
		this.domNode.style.setProperty('--stanza-sticky-line-height', `${lineHeight}px`);
		this.domNode.style.transform = `translate(${this.editor.getScrollLeft()}px, ${this.editor.getScrollTop()}px)`;
		this.domNode.style.width = `${layout.width - layout.verticalScrollbarWidth}px`;
		const focused = this.domNode.ownerDocument.activeElement;
		const hadFocus = this.domNode.contains(focused);
		const unused = new Set(this.rows.keys());
		for (const [index, lineNumber] of this.lines.entries()) {
			const lineId = String(this.model.getLineId(lineNumber - 1));
			let row = this.rows.get(lineId);
			if (!row) {
				const element = h(this.domNode.ownerDocument, 'div');
				element.className = 'stanza-editor-sticky-scroll-row';
				const button = h(this.domNode.ownerDocument, 'button');
				button.type = 'button';
				button.className = 'stanza-editor-sticky-scroll-item';
				button.dataset.lineId = lineId;
				button.tabIndex = index === 0 ? 0 : -1;
				const text = h(this.domNode.ownerDocument, 'span');
				text.className = 'stanza-editor-sticky-scroll-text';
				const number = h(this.domNode.ownerDocument, 'span');
				number.className = 'stanza-editor-sticky-scroll-number';
				number.setAttribute('aria-hidden', 'true');
				const folding = h(this.domNode.ownerDocument, 'button');
				folding.type = 'button';
				button.append(text);
				element.append(button, number, folding);
				row = { element, button, text, number, folding };
				this.rows.set(lineId, row);
			}
			unused.delete(lineId);
			const { element, button, text, number, folding } = row;
			const displayLine = state.showEndForLine === index ? state.endLineNumbers[index]! : lineNumber;
			button.dataset.lineNumber = String(displayLine);
			button.style.paddingLeft = `${layout.contentLeft}px`;
			text.style.textIndent = `${options.scrollWithEditor ? -this.editor.getScrollLeft() : 0}px`;
			element.style.marginTop = `${index === this.lines.length - 1 ? state.lastLineRelativePosition : 0}px`;
			element.style.clipPath = index === this.lines.length - 1 && state.lastLineRelativePosition < 0
				? `inset(${-state.lastLineRelativePosition}px 0 0)`
				: '';
			const label = this.model.getLineContent(displayLine);
			const mapping = projectStanzaSemanticTokenLine(
				text,
				label,
				this.model.tokenization.renderedTokens.getLineTokens(displayLine - 1),
				this.model.getOptions().tabSize,
			);
			this.characterMappings.set(text, mapping);
			button.title = localize('stickyScroll.reveal', 'Reveal line {0}: {1}', displayLine, label);
			button.setAttribute('aria-label', button.title);
			switch (lineNumbers.renderType) {
				case RenderLineNumbersType.On:
					number.textContent = String(displayLine);
					break;
				case RenderLineNumbersType.Relative:
					number.textContent = String(Math.abs(displayLine - currentLine));
					break;
				case RenderLineNumbersType.Interval:
					number.textContent = displayLine % 10 === 0 ? String(displayLine) : '';
					break;
				case RenderLineNumbersType.Custom:
					number.textContent = lineNumbers.renderFn!(displayLine);
					break;
				case RenderLineNumbersType.Off:
					number.textContent = '';
			}
			number.classList.toggle('active', displayLine === currentLine);
			number.style.left = `${layout.lineNumbersLeft}px`;
			number.style.width = `${layout.lineNumbersWidth}px`;
			const region = foldingModel.regions.find(region => region.startLineIndex === lineNumber - 1);
			folding.hidden = !region || !this.editor.getOption(EditorOption.folding) || foldingControls === 'never' || state.showEndForLine === index;
			folding.className = `stanza-editor-sticky-scroll-folding ${ThemeIcon.asClassName(region?.collapsed ? foldingCollapsedIcon : foldingExpandedIcon)}`;
			folding.classList.toggle('expanded', !!region && !region.collapsed);
			folding.setAttribute('aria-expanded', String(!region?.collapsed));
			folding.title = region?.collapsed
				? localize('stickyScroll.expand', 'Expand folded range at line {0}', lineNumber)
				: localize('stickyScroll.collapse', 'Collapse range at line {0}', lineNumber);
			folding.setAttribute('aria-label', folding.title);
			folding.style.left = `${layout.decorationsLeft}px`;
			folding.style.width = `${layout.decorationsWidth}px`;
			const current = this.domNode.children.item(index);
			if (current !== element) {
				this.domNode.insertBefore(element, current);
			}
		}
		for (const lineId of unused) {
			this.rows.get(lineId)!.element.remove();
			this.rows.delete(lineId);
		}
		this.domNode.hidden = this.lines.length === 0;
		this.domNode.classList.toggle('empty', this.domNode.hidden);
		if (hadFocus) {
			const index = this.getLineIndexFromChildDomNode(focused as HTMLElement);
			if (index !== null) {
				if ((focused as HTMLElement).hidden) {
					this.focusLineWithIndex(index);
				} else if (this.domNode.ownerDocument.activeElement !== focused) {
					(focused as HTMLElement).focus({ preventScroll: true });
				}
			} else {
				this.editor.focus();
			}
		}
	}
}
