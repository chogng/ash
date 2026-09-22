import './stickyScroll.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import type { TextModel } from '../../../common/model/textModel.js';

export class StickyScrollWidgetState {
	constructor(
		public readonly startLineNumbers: number[],
		public readonly endLineNumbers: number[],
		public readonly lastLineRelativePosition: number,
	) {}

	public static get Empty(): StickyScrollWidgetState {
		return new StickyScrollWidgetState([], [], 0);
	}
}

/** Owns retained header buttons; the controller mounts the root and handles navigation. */
export class StickyScrollWidget extends Disposable {
	private readonly domNode: HTMLDivElement;
	private lines: number[] = [];

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
		const button = this.domNode.children.item(index) as HTMLButtonElement | null;
		if (!button) {
			return;
		}
		for (const child of this.domNode.children) {
			(child as HTMLButtonElement).tabIndex = child === button ? 0 : -1;
		}
		button.focus({ preventScroll: true });
	}

	public getLineIndexFromChildDomNode(node: HTMLElement | null): number | null {
		const button = node?.closest('.stanza-editor-sticky-scroll-item');
		if (!button || button.parentElement !== this.domNode) {
			return null;
		}
		return Array.from(this.domNode.children).indexOf(button);
	}

	public setState(state: StickyScrollWidgetState): void {
		this.lines = state.startLineNumbers;
		const options = this.editor.getOption(EditorOption.stickyScroll);
		const layout = this.editor.getLayoutInfo();
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		this.editor.applyFontInfo(this.domNode);
		this.domNode.style.setProperty('--stanza-sticky-line-height', `${lineHeight}px`);
		this.domNode.style.transform = `translate(${this.editor.getScrollLeft()}px, ${this.editor.getScrollTop()}px)`;
		this.domNode.style.width = `${layout.width - layout.verticalScrollbarWidth}px`;
		const focused = this.domNode.ownerDocument.activeElement;
		const hadFocus = this.domNode.contains(focused);
		const buttons = new Map(Array.from(this.domNode.children, child => {
			const button = child as HTMLButtonElement;
			return [button.dataset.lineId, button] as const;
		}));
		for (const [index, lineNumber] of this.lines.entries()) {
			const lineId = String(this.model.getLineId(lineNumber - 1));
			let button = buttons.get(lineId);
			if (!button) {
				button = h(this.domNode.ownerDocument, 'button');
				button.type = 'button';
				button.className = 'stanza-editor-sticky-scroll-item';
				button.dataset.lineId = lineId;
				button.tabIndex = index === 0 ? 0 : -1;
			}
			buttons.delete(lineId);
			button.dataset.lineNumber = String(lineNumber);
			button.style.paddingLeft = `${layout.contentLeft}px`;
			button.style.textIndent = `${options.scrollWithEditor ? -this.editor.getScrollLeft() : 0}px`;
			button.style.marginTop = `${index === this.lines.length - 1 ? state.lastLineRelativePosition : 0}px`;
			button.style.clipPath = index === this.lines.length - 1 && state.lastLineRelativePosition < 0
				? `inset(${-state.lastLineRelativePosition}px 0 0)`
				: '';
			const label = this.model.getLineContent(lineNumber);
			if (button.textContent !== label) {
				button.textContent = label;
			}
			button.title = localize('stickyScroll.reveal', 'Reveal line {0}: {1}', lineNumber, label);
			button.setAttribute('aria-label', button.title);
			const current = this.domNode.children.item(index);
			if (current !== button) {
				this.domNode.insertBefore(button, current);
			}
		}
		for (const button of buttons.values()) {
			button.remove();
		}
		this.domNode.hidden = this.lines.length === 0;
		this.domNode.classList.toggle('empty', this.domNode.hidden);
		if (hadFocus) {
			const index = this.getLineIndexFromChildDomNode(focused as HTMLElement);
			if (index !== null) {
				this.focusLineWithIndex(index);
			} else {
				this.editor.focus();
			}
		}
	}
}
