import { h, type IDimension } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { observeElementSize } from '../../../../../base/browser/observer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import type { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { TextModel as OwnedTextModel } from '../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorPaneVisibility } from '../../../../browser/parts/editor/editorPane.js';
import type { EditorPanePart } from '../../../../browser/parts/editor/textResourceEditor.js';
import { MergeEditorModel, type MergeEditorChoice, type MergeEditorHunk, type MergeEditorSide } from '../model/mergeEditorModel.js';
import './media/mergeEditor.css';

type SourceSide = Exclude<MergeEditorSide, 'result'>;

export interface MergeResultEditor extends IDisposable {
	create(container: HTMLElement): void;
	clearInput(): void;
	layout(dimension: IDimension): void;
	setVisible(visibility: EditorPaneVisibility): void;
	focus(): void;
	getControl(): EditorPanePart | undefined;
}

/** Four code editors share one merge model; only the result owns a working file. */
export class MergeEditor extends Disposable {
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private readonly hunkButtons = this._register(new DisposableStore());
	private readonly hunkActionButtons: Button[] = [];
	private readonly sourceEditors = new Map<SourceSide, CodeEditorWidget>();
	private readonly sourceNodes = new Map<SourceSide, HTMLElement>();
	private domNode!: HTMLDivElement;
	private hunksDomNode!: HTMLDivElement;
	private resultDomNode!: HTMLDivElement;
	private resultPlaceholderDomNode!: HTMLDivElement;
	private previousButton!: Button;
	private nextButton!: Button;
	private model: MergeEditorModel | undefined;
	private activeHunk = 0;
	private syncingScroll = false;
	private pendingChoiceFocus: { readonly index: number; readonly choice: MergeEditorChoice } | undefined;

	constructor(
		public readonly resultEditor: MergeResultEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(resultEditor);
	}

	public create(container: HTMLElement): void {
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-merge-editor';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const navigation = h(document, 'nav');
		navigation.className = 'ash-merge-navigation';
		navigation.setAttribute('aria-label', localize({ bundle: 'ash', key: 'git.mergeConflictNavigation' }, 'Merge conflicts'));
		this.previousButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.previousConflict' }, 'Previous Conflict'),
			onClick: () => this.navigate(-1),
		}));
		this.nextButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.nextConflict' }, 'Next Conflict'),
			onClick: () => this.navigate(1),
		}));
		const inputs = h(document, 'div');
		inputs.className = 'ash-merge-inputs';
		for (const side of ['base', 'current', 'incoming'] as const) {
			const section = h(document, 'section');
			section.className = `ash-merge-input ash-merge-input-${side}`;
			const title = h(document, 'h3');
			title.textContent = sideLabel(side);
			const editorNode = h(document, 'div');
			editorNode.className = 'ash-merge-input-editor';
			section.append(title, editorNode);
			inputs.append(section);
			this.sourceNodes.set(side, editorNode);
			const editor = this._register(this.instantiationService.createInstance(CodeEditorWidget, {
				container: editorNode,
				model: null,
				readOnly: true,
				ariaLabel: sideLabel(side),
				minimap: { enabled: false },
			}));
			this.sourceEditors.set(side, editor);
			this._register(observeElementSize(editorNode, size => editor.layout(size)));
		}
		this.hunksDomNode = h(document, 'div');
		this.hunksDomNode.className = 'ash-merge-hunks';
		const resultSection = h(document, 'section');
		resultSection.className = 'ash-merge-result';
		const resultTitle = h(document, 'h3');
		resultTitle.textContent = localize({ bundle: 'ash', key: 'git.mergeResult' }, 'Result');
		this.resultDomNode = h(document, 'div');
		this.resultDomNode.className = 'ash-merge-result-editor';
		this.resultPlaceholderDomNode = h(document, 'div');
		this.resultPlaceholderDomNode.className = 'ash-merge-result-placeholder';
		resultSection.append(resultTitle, this.resultDomNode, this.resultPlaceholderDomNode);
		this.domNode.append(navigation, inputs, this.hunksDomNode, resultSection);
		this.resultEditor.create(this.resultDomNode);
		this._register(observeElementSize(this.resultDomNode, size => this.resultEditor.layout(size)));
		this.updateNavigation();
	}

	public setModel(model: MergeEditorModel): void {
		for (const editor of this.sourceEditors.values()) editor.setModel(null);
		this.session.clear();
		const store = new DisposableStore();
		this.session.value = store;
		this.model = model;
		for (const side of ['base', 'current', 'incoming'] as const) this.sourceEditors.get(side)!.setModel(model[side]);
		this.resultPlaceholderDomNode.hidden = true;
		store.add(model.onDidChange(() => this.renderHunks()));
		for (const side of ['base', 'current', 'incoming'] as const) {
			const editor = this.sourceEditors.get(side)!;
			store.add(editor.onDidScrollChange(event => this.synchronizeScroll(side, event)));
		}
		const resultControl = this.resultEditor.getControl();
		if (!resultControl) throw new Error('Merge result editor is not loaded');
		store.add(resultControl.onDidScrollChange(event => this.synchronizeScroll('result', event)));
		const decorations = new Map<MergeEditorSide, IEditorDecorationsCollection>();
		for (const side of ['base', 'current', 'incoming'] as const) decorations.set(side, this.sourceEditors.get(side)!.createDecorationsCollection());
		decorations.set('result', resultControl.createDecorationsCollection());
		store.add(toDisposable(() => { for (const collection of decorations.values()) collection.clear(); }));
		store.add(model.onDidChange(() => this.renderDecorations(decorations)));
		this.renderHunks();
		this.renderDecorations(decorations);
	}

	public showUnavailableSources(base: string, current: string, incoming: string, result: string | undefined): void {
		this.clearInput();
		const store = new DisposableStore();
		this.session.value = store;
		for (const [side, text] of [['base', base], ['current', current], ['incoming', incoming]] as const) {
			this.sourceEditors.get(side)!.setModel(store.add(new OwnedTextModel(text)));
		}
		this.resultPlaceholderDomNode.hidden = result === undefined;
		this.resultPlaceholderDomNode.textContent = result ?? '';
	}

	public clearInput(): void {
		for (const editor of this.sourceEditors.values()) editor.setModel(null);
		this.session.clear();
		this.model = undefined;
		this.resultEditor.clearInput();
		this.hunkButtons.clear();
		this.hunkActionButtons.length = 0;
		this.hunksDomNode?.replaceChildren();
		this.activeHunk = 0;
		this.pendingChoiceFocus = undefined;
		this.updateNavigation();
	}

	public layout(_dimension: IDimension): void {
		for (const [side, editor] of this.sourceEditors) {
			const node = this.sourceNodes.get(side)!;
			editor.layout({ width: node.clientWidth, height: node.clientHeight });
		}
		this.resultEditor.layout({ width: this.resultDomNode.clientWidth, height: this.resultDomNode.clientHeight });
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.resultEditor.setVisible(visibility);
	}

	public focus(): void { this.resultEditor.focus(); }

	public getAccessibleContent(): string {
		const model = this.model;
		return [
			`${sideLabel('base')}\n${model?.base.getValue() ?? this.sourceEditors.get('base')?.getModel()?.getValue() ?? ''}`,
			`${sideLabel('current')}\n${model?.current.getValue() ?? this.sourceEditors.get('current')?.getModel()?.getValue() ?? ''}`,
			`${sideLabel('incoming')}\n${model?.incoming.getValue() ?? this.sourceEditors.get('incoming')?.getModel()?.getValue() ?? ''}`,
			`${localize({ bundle: 'ash', key: 'git.mergeResult' }, 'Result')}\n${model?.result.getValue() ?? this.resultEditor.getControl()?.getValue() ?? this.resultPlaceholderDomNode.textContent ?? ''}`,
		].join('\n\n');
	}

	private navigate(step: number): void {
		const hunks = this.model?.hunks;
		if (!hunks?.length) return;
		this.activeHunk = (this.activeHunk + step + hunks.length) % hunks.length;
		this.revealHunk(hunks[this.activeHunk]);
	}

	private revealHunk(hunk: MergeEditorHunk): void {
		const resultControl = this.resultEditor.getControl();
		const range = rangeForLines(this.model!.result, hunk.result);
		resultControl?.setSelection(range, 'mergeEditor');
		resultControl?.revealRange?.(range);
		for (const side of ['base', 'current', 'incoming'] as const) {
			this.sourceEditors.get(side)!.revealRange(rangeForLines(this.model![side], hunk[side]));
		}
		this.renderHunks();
	}

	private renderHunks(): void {
		const model = this.model;
		if (!model) return;
		if (!model.isReady) {
			for (const button of this.hunkActionButtons) button.enabled = false;
			return;
		}
		this.hunkButtons.clear();
		this.hunkActionButtons.length = 0;
		this.hunksDomNode.replaceChildren();
		let focusButton: Button | undefined;
		for (const hunk of model.hunks) {
			const row = h(this.domNode.ownerDocument, 'div');
			row.className = 'ash-merge-hunk';
			if (hunk.index === this.activeHunk) row.classList.add('active');
			const select = this.hunkButtons.add(new Button(row, {
				label: localize({ bundle: 'ash', key: 'git.mergeBlock' }, 'Conflict {0}', hunk.index + 1),
				onClick: () => { this.activeHunk = hunk.index; this.revealHunk(hunk); },
			}));
			select.domNode.classList.add('ash-merge-hunk-select');
			const state = h(this.domNode.ownerDocument, 'span');
			state.className = 'ash-merge-hunk-state';
			state.textContent = hunk.unresolved
				? localize({ bundle: 'ash', key: 'git.mergeUnresolvedState' }, 'Unresolved')
				: localize({ bundle: 'ash', key: 'git.mergeResolvedState' }, 'Resolved');
			row.append(state);
			for (const [choice, label] of [
				['current', localize({ bundle: 'ash', key: 'git.acceptCurrent' }, 'Accept Current')],
				['incoming', localize({ bundle: 'ash', key: 'git.acceptIncoming' }, 'Accept Incoming')],
				['both', localize({ bundle: 'ash', key: 'git.acceptBoth' }, 'Accept Both')],
			] as const) {
				const action = this.hunkButtons.add(new Button(row, { label, onClick: () => this.acceptHunk(hunk.index, choice) }));
				this.hunkActionButtons.push(action);
				if (this.pendingChoiceFocus?.index === hunk.index && this.pendingChoiceFocus.choice === choice) focusButton = action;
			}
			this.hunksDomNode.append(row);
		}
		this.updateNavigation();
		focusButton?.focus();
		this.pendingChoiceFocus = undefined;
	}

	private acceptHunk(index: number, choice: MergeEditorChoice): void {
		const model = this.model;
		const control = this.resultEditor.getControl();
		if (!model?.isReady || !control) return;
		const edit = model.editForHunk(index, choice);
		this.pendingChoiceFocus = { index, choice };
		if (!control.executeEdits('mergeEditor', [edit])) this.pendingChoiceFocus = undefined;
		this.activeHunk = index;
	}

	private renderDecorations(collections: Map<MergeEditorSide, IEditorDecorationsCollection>): void {
		const model = this.model;
		if (!model) return;
		if (!model.isReady) {
			for (const collection of collections.values()) collection.clear();
			return;
		}
		for (const side of ['base', 'current', 'incoming', 'result'] as const) {
			const textModel = model[side];
			collections.get(side)?.set(model.hunks.filter(hunk => !hunk[side].isEmpty).map(hunk => ({
				range: rangeForLines(textModel, hunk[side]),
				options: { description: 'merge-conflict', isWholeLine: true, className: hunk.unresolved ? 'ash-merge-line-unresolved' : 'ash-merge-line-resolved' },
			})));
		}
	}

	private synchronizeScroll(source: MergeEditorSide, event: { readonly scrollTopChanged: boolean; readonly scrollLeftChanged: boolean }): void {
		const model = this.model;
		if (!model?.isReady || this.syncingScroll) return;
		const sourceEditor = source === 'result' ? this.resultEditor.getControl() : this.sourceEditors.get(source);
		if (!sourceEditor) return;
		this.syncingScroll = true;
		try {
			const topLine = sourceEditor.getVisibleRanges()[0]?.startLineNumber ?? 1;
			const relativeTop = sourceEditor.getScrollTop() - sourceEditor.getTopForLineNumber(topLine);
			for (const side of ['base', 'current', 'incoming', 'result'] as const) {
				if (side === source) continue;
				const target = side === 'result' ? this.resultEditor.getControl() : this.sourceEditors.get(side);
				if (!target) continue;
				if (event.scrollTopChanged) target.setScrollTop(target.getTopForLineNumber(model.mapLine(source, side, topLine)) + relativeTop);
				if (event.scrollLeftChanged) target.setScrollLeft(sourceEditor.getScrollLeft());
			}
		} finally {
			this.syncingScroll = false;
		}
	}

	private updateNavigation(): void {
		if (!this.previousButton || !this.nextButton) return;
		const enabled = (this.model?.hunks.length ?? 0) > 0;
		this.previousButton.enabled = enabled;
		this.nextButton.enabled = enabled;
	}
}

function sideLabel(side: SourceSide): string {
	switch (side) {
		case 'base': return localize({ bundle: 'ash', key: 'git.mergeBase' }, 'Base');
		case 'current': return localize({ bundle: 'ash', key: 'git.mergeCurrent' }, 'Current');
		case 'incoming': return localize({ bundle: 'ash', key: 'git.mergeIncoming' }, 'Incoming');
	}
}

function rangeForLines(model: TextModel, lines: LineRange): Range {
	const start = Math.min(lines.startLineNumber, model.getLineCount());
	const end = Math.min(lines.endLineNumberExclusive, model.getLineCount());
	return new Range(start, 1, end, lines.endLineNumberExclusive > model.getLineCount() ? model.getLineMaxColumn(end) : 1);
}
