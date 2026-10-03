import { h, svg } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { Range } from '../../../../common/core/range.js';
import type { DiffModel } from '../../../../common/diff/diffModel.js';
import type { MovedText } from '../../../../common/diff/linesDiffComputer.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

/** Renders movement links without retaining a second scroll or diff state. */
export class MovedBlocksLinesFeature extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly svgNode: SVGSVGElement;
	private readonly controls = this._register(new DisposableStore());
	private readonly links: { move: MovedText; path: SVGPathElement; button: HTMLElement }[] = [];
	private readonly originalDecorations;
	private readonly modifiedDecorations;
	private enabled = false;
	private height = 0;

	constructor(container: HTMLElement, private readonly model: DiffModel, private readonly original: CodeEditorWidget, private readonly modified: CodeEditorWidget) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-diff-moved-links';
		this.svgNode = svg(container.ownerDocument, 'svg');
		this.svgNode.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.svgNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.originalDecorations = original.createDecorationsCollection();
		this.modifiedDecorations = modified.createDecorationsCollection();
		this._register(toDisposable(() => { this.originalDecorations.clear(); this.modifiedDecorations.clear(); }));
		for (const editor of [original, modified]) {
			this._register(editor.onDidScrollChange(() => this.positionLinks()));
			this._register(editor.onDidLayoutChange(() => this.positionLinks()));
		}
		this._register(onDidChangeNls(() => this.update(this.enabled)));
	}

	public get width(): number {
		return this.links.length > 0 ? 24 : 0;
	}

	public update(enabled: boolean): void {
		this.enabled = enabled;
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.controls.clear();
		this.links.length = 0;
		this.svgNode.replaceChildren();
		const moves = enabled ? this.model.diff?.moves ?? [] : [];
		this.domNode.hidden = moves.length === 0;
		for (const [decorations, side] of [
			[this.originalDecorations, 'original'],
			[this.modifiedDecorations, 'modified'],
		] as const) {
			decorations.set(moves.map(move => ({
				range: move.lineRangeMapping[side].toInclusiveRange()!,
				options: { description: 'diff-moved-block', className: 'ash-diff-moved-block', isWholeLine: true },
			})));
		}
		for (const move of moves) {
			const mapping = move.lineRangeMapping;
			const label = localize('diffEditor.movedLines', 'Moved original lines {0}–{1} to modified lines {2}–{3}',
				mapping.original.startLineNumber, mapping.original.endLineNumberExclusive - 1,
				mapping.modified.startLineNumber, mapping.modified.endLineNumberExclusive - 1);
			const path = svg(this.domNode.ownerDocument, 'path');
			this.svgNode.append(path);
			const host = h(this.domNode.ownerDocument, 'div');
			host.className = 'ash-diff-moved-action';
			this.domNode.append(host);
			this.controls.add(toDisposable(() => host.remove()));
			this.controls.add(new Button(host, { label, icon: Lxicon.arrowRight, iconOnly: true, size: 'small', onClick: () => {
				const line = mapping.modified.startLineNumber;
				this.modified.revealRange(new Range(line, 1, line, 1));
				this.modified.focus();
				this.modified.announceAccessibilityStatus(label);
			} }));
			this.links.push({ move, path, button: host });
		}
		this.positionLinks();
		if (hadFocus) this.modified.focus();
	}

	public layout(left: number, height: number): void {
		this.height = height;
		this.domNode.style.left = `${left}px`;
		this.domNode.style.width = `${this.width}px`;
		this.svgNode.setAttribute('viewBox', `0 0 ${this.width} ${height}`);
		this.positionLinks();
	}

	private positionLinks(): void {
		for (const { move, path, button } of this.links) {
			const source = this.original.getTopForLineNumber(move.lineRangeMapping.original.startLineNumber) - this.original.getScrollTop();
			const target = this.modified.getTopForLineNumber(move.lineRangeMapping.modified.startLineNumber) - this.modified.getScrollTop();
			const middle = this.width / 2;
			const originalCenter = source + this.original.getOption(EditorOption.lineHeight) / 2;
			const modifiedCenter = target + this.modified.getOption(EditorOption.lineHeight) / 2;
			path.setAttribute('d', `M 0 ${originalCenter} C ${middle} ${originalCenter} ${middle} ${modifiedCenter} ${this.width} ${modifiedCenter}`);
			button.hidden = target < 0 || target >= this.height;
			button.style.top = `${target}px`;
		}
	}
}
