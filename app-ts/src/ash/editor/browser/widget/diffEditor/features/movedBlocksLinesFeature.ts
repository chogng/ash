import { h, svg } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import type { DiffModel } from '../../../../common/diff/diffModel.js';
import type { MovedText } from '../../../../common/diff/linesDiffComputer.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

/** Renders movement links without retaining a second scroll or diff state. */
export class MovedBlocksLinesFeature extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly svgNode: SVGSVGElement;
	private readonly comparisonDomNode: HTMLDivElement;
	private readonly comparisonLabel: HTMLSpanElement;
	private readonly closeButton: Button;
	private readonly controls = this._register(new DisposableStore());
	private readonly links: { move: MovedText; path: SVGPathElement; button: HTMLElement }[] = [];
	private readonly originalDecorations;
	private readonly modifiedDecorations;
	private enabled = false;
	private height = 0;
	private selectedMove: MovedText | undefined;

	constructor(container: HTMLElement, private readonly model: DiffModel, private readonly original: CodeEditorWidget, private readonly modified: CodeEditorWidget, private readonly compare: (move: MovedText | undefined) => void) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-diff-moved-links';
		this.svgNode = svg(container.ownerDocument, 'svg');
		this.svgNode.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.svgNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.comparisonDomNode = h(container.ownerDocument, 'div');
		this.comparisonDomNode.className = 'ash-diff-moved-comparison';
		this.comparisonDomNode.setAttribute('role', 'toolbar');
		this.comparisonDomNode.hidden = true;
		this.comparisonLabel = h(container.ownerDocument, 'span');
		this.comparisonDomNode.append(this.comparisonLabel);
		container.append(this.comparisonDomNode);
		this._register(toDisposable(() => this.comparisonDomNode.remove()));
		this.closeButton = this._register(new Button(this.comparisonDomNode, { label: '', size: 'small', onClick: () => this.compare(undefined) }));
		this.originalDecorations = original.createDecorationsCollection();
		this.modifiedDecorations = modified.createDecorationsCollection();
		this._register(toDisposable(() => { this.originalDecorations.clear(); this.modifiedDecorations.clear(); }));
		for (const editor of [original, modified]) {
			this._register(editor.onDidScrollChange(() => this.positionLinks()));
			this._register(editor.onDidLayoutChange(() => this.positionLinks()));
		}
	}

	public get width(): number {
		return this.links.length > 0 ? 24 : 0;
	}

	public get headerHeight(): number {
		return this.selectedMove ? 32 : 0;
	}

	public update(enabled: boolean, selectedMove?: MovedText): void {
		const lostHeaderFocus = !selectedMove && this.comparisonDomNode.contains(this.domNode.ownerDocument.activeElement);
		this.enabled = enabled;
		this.selectedMove = selectedMove;
		this.comparisonDomNode.hidden = !selectedMove;
		this.closeButton.label = localize('diffEditor.stopComparingMovedCode', 'Stop comparing moved code');
		this.comparisonDomNode.setAttribute('aria-label', localize('diffEditor.movedComparison', 'Moved code comparison'));
		if (selectedMove) {
			const mapping = selectedMove.lineRangeMapping;
			this.comparisonLabel.textContent = localize('diffEditor.comparingMovedCode', 'Comparing original lines {0}–{1} with modified lines {2}–{3}',
				mapping.original.startLineNumber, mapping.original.endLineNumberExclusive - 1,
				mapping.modified.startLineNumber, mapping.modified.endLineNumberExclusive - 1);
			this.comparisonLabel.title = this.comparisonLabel.textContent;
		}
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
			path.classList.toggle('compared', move === selectedMove);
			this.svgNode.append(path);
			const host = h(this.domNode.ownerDocument, 'div');
			host.className = 'ash-diff-moved-action';
			this.domNode.append(host);
			this.controls.add(toDisposable(() => host.remove()));
			this.controls.add(new Button(host, { label, icon: Lxicon.arrowRight, iconOnly: true, size: 'small', onClick: () => {
				this.compare(move === this.selectedMove ? undefined : move);
			} }));
			this.links.push({ move, path, button: host });
		}
		this.positionLinks();
		if (hadFocus || lostHeaderFocus) {
			this.modified.focus();
		}
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
