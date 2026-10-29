import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { readDesignTextHtml } from './textClipboard.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { DesignMode } from '../../../common/config/editorConfiguration.js';
import { getDesignShapeEntries } from '../../../common/model/hitTest.js';
import {
	designTextStyleAt,
	designTextSegments,
	designTextReplacement,
	parseDesignTextProperties,
	type DesignTextStyle,
	type DesignTextShape,
} from '../../../common/model/designText.js';
import { renderDesignTextFrame } from '../../../browser/designTextRendering.js';
import type { DesignEditorContributionContext, IDesignTextContribution } from '../../../browser/designEditorBrowser.js';
import './designTextEditor.css';

const clipboardType = 'application/x-ash-design-text';
/** DOM owns an in-flight IME composition; committed text always lives in DesignModel. */
export class DesignTextEditor extends Disposable implements IDesignTextContribution {
	private readonly overlay: SVGForeignObjectElement;
	private editor: HTMLDivElement | undefined;
	private id: string | undefined;
	private start = 0;
	private end = 0;
	private composing = false;
	private changing = false;
	private pendingStyle: DesignTextStyle | undefined;
	private pendingStyleId: string | undefined;
	private pendingOverrides: (keyof DesignTextStyle)[] = [];
	private typingGroup: object = {};
	private rendered: DesignTextShape | undefined;
	private readonly selectionEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeSelection = this.selectionEmitter.event;
	public get editingId(): string | undefined {
		return this.id;
	}
	public get typingStyleId(): string | undefined {
		return this.pendingStyleId;
	}
	public get typingStyle(): DesignTextStyle | undefined {
		return this.pendingStyle;
	}
	public get range(): { start: number; end: number } | undefined {
		return this.id ? { start: this.start, end: this.end } : undefined;
	}
	constructor(
		private readonly context: DesignEditorContributionContext,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.overlay = context.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
		this.overlay.classList.add('ash-sessions-design-text-editor');
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(AccessibilityVerbositySettingId.DesignCanvas)) {
					this.updateHelpHint();
				}
			}),
		);
		this.overlay.style.display = 'none';
		context.overlayDomNode.append(this.overlay);
		this._register(toDisposable(() => this.overlay.remove()));
		for (const event of ['pointerdown', 'mousedown', 'dblclick', 'contextmenu', 'wheel'] as const) {
			this._register(addDisposableListener(this.overlay, event, event => event.stopPropagation()));
		}
		this._register(addDisposableListener(context.ownerDocument, 'selectionchange', () => this.captureSelection()));
		// Keyboard focus returning from Typography restores the saved caret; a subsequent pointer click can place it elsewhere.
		this._register(
			addDisposableListener(this.overlay, 'focusin', event => {
				if (event.target === this.editor) {
					this.restoreSelection();
				}
			}),
		);
		this._register(
			addDisposableListener(this.overlay, 'beforeinput', event => this.beforeInput(event as InputEvent)),
		);
		this._register(
			addDisposableListener(this.overlay, 'input', () => {
				if (!this.composing) {
					this.commitDOM();
				}
			}),
		);
		this._register(
			addDisposableListener(this.overlay, 'compositionstart', () => {
				this.captureSelection();
				this.composing = true;
				this.typingGroup = {};
			}),
		);
		this._register(
			addDisposableListener(this.overlay, 'compositionend', () => {
				this.composing = false;
				this.commitDOM();
				this.typingGroup = {};
			}),
		);
		this._register(addDisposableListener(this.overlay, 'keydown', event => this.keyDown(event)));
		this._register(
			addDisposableListener(this.overlay, 'dragover', event => {
				event.preventDefault();
				event.stopPropagation();
			}),
		);
		this._register(
			addDisposableListener(this.overlay, 'drop', event => {
				event.preventDefault();
				event.stopPropagation();
				this.typingGroup = {};
				this.replace(event.dataTransfer?.getData('text/plain') ?? '');
				this.typingGroup = {};
			}),
		);
		for (const event of ['copy', 'cut', 'paste'] as const) {
			this._register(addDisposableListener(this.overlay, event, event => this.clipboard(event)));
		}
	}
	public edit(id: string): void {
		if (
			this.context.documentController.isBusy ||
			this.context.getMode() === DesignMode.Code ||
			this.context.getMode() === DesignMode.Motion
		) {
			return;
		}
		const shape = this.context.commands.text.get(id);
		if (!shape) {
			return;
		}
		if (this.id !== id) {
			this.finish();
			this.id = id;
			this.start = 0;
			this.end = shape.text.length;
			this.typingGroup = {};
		}
		this.context.selectShape(id);
		this.update();
		this.editor?.focus();
		this.restoreSelection();
		this.context.renderCanvas();
	}
	public finish(commit = true): void {
		if (!this.id) {
			return;
		}
		if (this.composing) {
			this.composing = false;
			if (commit) {
				this.commitDOM();
			}
		}
		this.id = undefined;
		this.pendingStyle = undefined;
		this.pendingStyleId = undefined;
		this.pendingOverrides = [];
		this.rendered = undefined;
		this.overlay.style.display = 'none';
		this.overlay.replaceChildren();
		this.editor = undefined;
		this.selectionEmitter.fire();
	}
	public update(): void {
		const shape = this.id ? this.context.commands.text.get(this.id) : undefined;
		if (
			!shape ||
			!this.context.selection.ids.has(shape.id) ||
			this.context.selection.ids.size !== 1 ||
			this.context.documentController.isBusy ||
			this.context.getMode() === DesignMode.Code ||
			this.context.getMode() === DesignMode.Motion
		) {
			this.finish(false);
			return;
		}
		const entry = getDesignShapeEntries(this.context.documentController.model.value.shapes).find(
			entry => entry.shape.id === shape.id,
		)!;
		const world = entry.world;
		for (const [key, value] of Object.entries({
			x: 0,
			y: 0,
			width: Math.max(shape.width, 1),
			height: Math.max(shape.height, shape.fontSize * 1.2),
		})) {
			this.overlay.setAttribute(key, String(value));
		}
		this.overlay.setAttribute(
			'transform',
			`translate(${world.x + world.width / 2} ${world.y + world.height / 2}) rotate(${world.rotation}) scale(${entry.parentScale}) translate(${-shape.width / 2} ${-shape.height / 2})`,
		);
		this.overlay.style.display = '';
		if (this.editor) {
			const parent = this.editor.parentElement!;
			parent.style.justifyContent =
				shape.textVerticalAlign === 'center'
					? 'center'
					: shape.textVerticalAlign === 'bottom'
						? 'flex-end'
						: 'flex-start';
		}
		if (this.composing && this.rendered?.text !== shape.text) {
			this.composing = false;
		}
		if (this.composing || this.rendered === shape) {
			return;
		}
		const focused = this.context.ownerDocument.activeElement === this.editor;
		const frame = renderDesignTextFrame(this.context.ownerDocument, shape, true);
		this.editor = frame.querySelector<HTMLDivElement>('[data-design-text]')!;
		this.editor.contentEditable = 'true';
		this.editor.setAttribute('contenteditable', 'true');
		this.editor.setAttribute('role', 'textbox');
		this.editor.setAttribute('aria-multiline', 'true');
		this.editor.setAttribute('aria-label', localize('sessions.design.editText', 'Edit text'));
		this.editor.spellcheck = false;
		this.updateHelpHint();
		this.overlay.replaceChildren(frame);
		this.rendered = shape;
		this.start = Math.min(this.start, shape.text.length);
		this.end = Math.min(this.end, shape.text.length);
		if (focused) {
			this.editor.focus();
			this.restoreSelection();
		}
	}
	private captureSelection(): void {
		if (this.changing || this.composing || !this.editor) {
			return;
		}
		const selection = this.context.ownerDocument.getSelection();
		if (
			!selection?.rangeCount ||
			!this.editor.contains(selection.anchorNode) ||
			!this.editor.contains(selection.focusNode)
		) {
			return;
		}
		const range = selection.getRangeAt(0);
		const before = range.cloneRange();
		before.selectNodeContents(this.editor);
		before.setEnd(range.startContainer, range.startOffset);
		const start = before.toString().length;
		const end = start + range.toString().length;
		if (start !== this.start || end !== this.end) {
			this.start = start;
			this.end = end;
			this.pendingStyle = undefined;
			this.pendingStyleId = undefined;
			this.pendingOverrides = [];
			this.typingGroup = {};
			this.selectionEmitter.fire();
		}
	}
	private restoreSelection(): void {
		if (!this.editor) {
			return;
		}
		const document = this.context.ownerDocument;
		const walker = document.createTreeWalker(this.editor, 4);
		const nodes: Text[] = [];
		while (walker.nextNode()) {
			nodes.push(walker.currentNode as Text);
		}
		const point = (offset: number): [Node, number] => {
			for (const node of nodes) {
				if (offset <= node.length) {
					return [node, offset];
				}
				offset -= node.length;
			}
			return [this.editor!, this.editor!.childNodes.length];
		};
		const range = document.createRange();
		range.setStart(...point(this.start));
		range.setEnd(...point(this.end));
		const selection = document.getSelection();
		selection?.removeAllRanges();
		selection?.addRange(range);
	}
	private replace(text: string, runs?: ReturnType<typeof designTextSegments>): void {
		if (!this.id) {
			return;
		}
		const { start, end } = this;
		this.start = this.end = start + text.length;
		this.changing = true;
		try {
			this.context.commands.text.replace(
				this.id,
				start,
				end,
				text,
				this.pendingStyle,
				this.typingGroup,
				runs ??
					(this.pendingStyleId && text
						? [
								{
									start: 0,
									end: text.length,
									styleId: this.pendingStyleId,
									overrides: this.pendingOverrides,
									style: {
										fill: designTextStyleAt(
											this.context.commands.text.get(this.id)!,
											Math.max(0, start - 1),
										).fill,
										...this.pendingStyle,
									},
								},
							]
						: undefined),
			);
			this.update();
			this.restoreSelection();
		} finally {
			this.changing = false;
		}
		this.selectionEmitter.fire();
	}
	private beforeInput(event: InputEvent): void {
		if (event.isComposing || this.composing || !this.id) {
			return;
		}
		this.captureSelection();
		const shape = this.context.commands.text.get(this.id)!;
		if (event.inputType.startsWith('insert') && !['insertFromPaste', 'insertFromDrop'].includes(event.inputType)) {
			event.preventDefault();
			this.replace(
				event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak'
					? '\n'
					: (event.data ?? ''),
			);
		} else if (event.inputType.startsWith('delete')) {
			event.preventDefault();
			if (this.start === this.end) {
				const backward = event.inputType.endsWith('Backward');
				const segments = [
					...new Intl.Segmenter(undefined, {
						granularity: event.inputType.includes('Word') ? 'word' : 'grapheme',
					}).segment(shape.text),
				];
				if (backward) {
					this.start = segments.filter(part => part.index < this.start).at(-1)?.index ?? 0;
				} else {
					this.end = segments.find(part => part.index > this.end)?.index ?? shape.text.length;
				}
			}
			this.replace('');
		} else if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
			event.preventDefault();
			this.history(event.inputType === 'historyRedo');
		}
	}
	private commitDOM(): void {
		if (!this.editor || !this.id) {
			return;
		}
		const shape = this.context.commands.text.get(this.id);
		if (!shape) {
			return;
		}
		const text = this.editor.textContent?.replace(/\r\n?/gu, '\n') ?? '';
		if (text === shape.text) {
			return;
		}
		// IME commits one replacement; preserve unaffected rich ranges on both sides.
		const replacement = designTextReplacement(shape.text, text);
		this.start = replacement.start;
		this.end = replacement.end;
		this.replace(replacement.text);
	}
	public format(style: DesignTextStyle, styleId?: string): void {
		if (!this.id) {
			return;
		}
		this.typingGroup = {};
		if (
			!styleId &&
			Object.keys(style).some(key =>
				[
					'textAlign',
					'textDirection',
					'paragraphSpacing',
					'paragraphIndent',
					'listType',
					'textWrap',
					'textTrim',
				].includes(key),
			)
		) {
			const shape = this.context.commands.text.get(this.id)!;
			const start = shape.text.lastIndexOf('\n', Math.max(-1, this.start - 1)) + 1;
			const newline = shape.text.indexOf('\n', Math.max(this.start, this.end - 1));
			const end = newline < 0 ? shape.text.length : newline + 1;
			this.changing = true;
			try {
				this.context.commands.text.format(this.id, start, end, style, styleId);
			} finally {
				this.changing = false;
			}
		} else if (this.start === this.end) {
			this.pendingStyle = { ...(styleId ? {} : this.pendingStyle), ...style };
			if (styleId) {
				this.pendingStyleId = styleId;
				this.pendingOverrides = [];
			} else if (this.pendingStyleId) {
				this.pendingOverrides = [
					...new Set([...this.pendingOverrides, ...(Object.keys(style) as (keyof DesignTextStyle)[])]),
				];
			}
		} else {
			this.changing = true;
			try {
				this.context.commands.text.format(this.id, this.start, this.end, style, styleId);
			} finally {
				this.changing = false;
			}
		}
		this.selectionEmitter.fire();
	}
	private updateHelpHint(): void {
		if (this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.DesignCanvas)) {
			this.editor?.setAttribute(
				'aria-description',
				localize('sessions.design.textHelpHint', 'Press Alt+F1 for text editing help.'),
			);
		} else {
			this.editor?.removeAttribute('aria-description');
		}
	}
	public getAccessibleContent(): string {
		const shape = this.id ? this.context.commands.text.get(this.id) : undefined;
		if (!shape) {
			return '';
		}
		const style = { ...designTextStyleAt(shape, this.start), ...this.pendingStyle };
		return (
			localize(
				'sessions.design.textSelectionDescription',
				'Text selection {0}–{1}. Font {2}, size {3}.',
				this.start,
				this.end,
				style.fontFamily ?? 'sans-serif',
				style.fontSize ?? shape.fontSize,
			) +
			'\n' +
			shape.text.slice(this.start, this.end)
		);
	}

	private history(redo: boolean): void {
		this.typingGroup = {};
		this.pendingStyle = undefined;
		this.pendingStyleId = undefined;
		this.pendingOverrides = [];
		if (redo) {
			this.context.documentController.model.redo();
		} else {
			this.context.documentController.model.undo();
		}
		this.update();
		this.editor?.focus();
		this.restoreSelection();
	}
	private keyDown(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.isComposing || this.composing) {
			return;
		}
		if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
			event.preventDefault();
			this.finish();
			this.context.canvasDomNode.closest<HTMLElement>('[role="region"]')?.focus();
			this.context.renderCanvas();
			return;
		}
		if (!(event.ctrlKey || event.metaKey)) {
			return;
		}
		const key = event.key.toLowerCase();
		if (key === 'z' || key === 'y') {
			event.preventDefault();
			this.history(key === 'y' || event.shiftKey);
		}
		if (!['b', 'i', 'u'].includes(key) || !this.id) {
			return;
		}
		event.preventDefault();
		this.toggleFormat(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline');
	}
	public selectAll(): void {
		if (!this.id) {
			return;
		}
		this.start = 0;
		this.end = this.context.commands.text.get(this.id)!.text.length;
		this.pendingStyle = undefined;
		this.pendingStyleId = undefined;
		this.pendingOverrides = [];
		this.typingGroup = {};
		this.editor?.focus();
		this.restoreSelection();
		this.selectionEmitter.fire();
	}
	public toggleFormat(format: 'bold' | 'italic' | 'underline'): void {
		if (!this.id) {
			return;
		}
		this.captureSelection();
		if (this.start !== this.end) {
			this.changing = true;
			this.typingGroup = {};
			try {
				this.context.commands.text.toggle(this.id, this.start, this.end, format);
			} finally {
				this.changing = false;
			}
			this.selectionEmitter.fire();
			this.editor?.focus();
			this.restoreSelection();
			return;
		}
		const style = {
			...designTextStyleAt(this.context.commands.text.get(this.id)!, this.start),
			...this.pendingStyle,
		};
		this.format(
			format === 'bold'
				? { fontWeight: (style.fontWeight ?? 400) >= 600 ? 400 : 700 }
				: format === 'italic'
					? { fontStyle: style.fontStyle === 'italic' ? 'normal' : 'italic' }
					: {
							textDecoration: style.textDecoration?.includes('underline')
								? style.textDecoration.includes('line-through')
									? 'line-through'
									: 'none'
								: style.textDecoration?.includes('line-through')
									? 'underline line-through'
									: 'underline',
						},
		);
		this.editor?.focus();
		this.restoreSelection();
	}

	private clipboard(event: ClipboardEvent): void {
		if (!this.id || !event.clipboardData) {
			return;
		}
		this.captureSelection();
		event.preventDefault();
		event.stopPropagation();
		const shape = this.context.commands.text.get(this.id)!;
		if (event.type === 'paste') {
			let text = event.clipboardData.getData('text/plain').replace(/\r\n?/gu, '\n');
			let runs: ReturnType<typeof designTextSegments> | undefined;
			try {
				const rich = JSON.parse(event.clipboardData.getData(clipboardType));
				if (rich.text === text) {
					runs = parseDesignTextProperties(rich).textRuns?.slice();
				}
			} catch {
				/* External clipboard is parsed independently below. */
			}
			if (!runs && event.clipboardData.getData('text/html')) {
				const rich = readDesignTextHtml(this.context.ownerDocument, event.clipboardData.getData('text/html'));
				if (rich.text) {
					text = rich.text;
					runs = rich.runs.slice();
				}
			}
			this.typingGroup = {};
			this.replace(text, runs);
			this.typingGroup = {};
			return;
		}
		const text = shape.text.slice(this.start, this.end);
		const textRuns = designTextSegments(shape, this.start, this.end).map(run => ({
			start: run.start - this.start,
			end: run.end - this.start,
			style: { ...designTextStyleAt(shape, run.start) },
		}));
		event.clipboardData.setData(
			'text/html',
			renderDesignTextFrame(this.context.ownerDocument, { ...shape, text, textRuns, textTruncate: false })
				.outerHTML,
		);
		event.clipboardData.setData('text/plain', text);
		event.clipboardData.setData(clipboardType, JSON.stringify({ text, textRuns }));
		if (event.type === 'cut') {
			this.typingGroup = {};
			this.replace('');
			this.typingGroup = {};
		}
	}
}
