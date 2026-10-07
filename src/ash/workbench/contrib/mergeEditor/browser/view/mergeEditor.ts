import { getWindow, h, type IDimension } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { observeElementSize } from '../../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import type { ICodeEditor } from '../../../../../editor/browser/editorBrowser.js';
import type { EditorLayoutInfo } from '../../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../../editor/common/core/range.js';
import type { LineRange } from '../../../../../editor/common/core/ranges/lineRange.js';
import type { IEditorDecorationsCollection } from '../../../../../editor/common/editorCommon.js';
import type { IModelDeltaDecoration } from '../../../../../editor/common/model.js';
import type { TextModel } from '../../../../../editor/common/model/textModel.js';
import { TextModel as OwnedTextModel } from '../../../../../editor/common/model/textModel.js';
import { localize } from '../../../../../nls.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';

import type { EditorPanePart } from '../../../../browser/parts/editor/textResourceEditor.js';
import { MergeEditorModel, type MergeEditorChoice, type MergeEditorHunk, type MergeEditorSide } from '../model/mergeEditorModel.js';
import { getAlignments } from './lineAlignment.js';
import './media/mergeEditor.css';

type SourceSide = Exclude<MergeEditorSide, 'result'>;
type MergeCodeEditor = Pick<ICodeEditor, 'changeViewZones' | 'getTopForLineNumber' | 'getBottomForLineNumber' | 'getModel'>;
type MergeGeometryEditor = Pick<ICodeEditor, 'onDidChangeConfiguration' | 'onDidLayoutChange' | 'getLayoutInfo'>;

interface MergeZone {
	readonly afterLineNumber: number;
	readonly heightInPx: number;
	readonly hunkIndex?: number;
}

export interface MergeResultEditor extends IDisposable {
	create(container: HTMLElement): void;
	clearInput(): void;
	layout(dimension: IDimension): void;
	setVisible(visibility: boolean): void;
	focus(): void;
	getControl(): EditorPanePart | undefined;
}

/** Four code editors share one merge model; only the result owns a working file. */
export class MergeEditor extends Disposable {
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private readonly hunkButtons = this._register(new DisposableStore());
	private readonly zoneButtons = this._register(new DisposableStore());
	private readonly hunkActionButtons: Button[] = [];
	private readonly zoneIds = new Map<MergeEditorSide, string[]>();
	private readonly sourceEditors = new Map<SourceSide, CodeEditorWidget>();
	private readonly sourceNodes = new Map<SourceSide, HTMLElement>();
	private alignmentScheduler!: AnimationFrameScheduler;
	private domNode!: HTMLDivElement;
	private hunksDomNode!: HTMLDivElement;
	private resultDomNode!: HTMLDivElement;
	private resultPlaceholderDomNode!: HTMLDivElement;
	private baseSection!: HTMLElement;
	private previousButton!: Button;
	private nextButton!: Button;
	private previousUnresolvedButton!: Button;
	private nextUnresolvedButton!: Button;
	private acceptRemainingCurrentButton!: Button;
	private acceptRemainingIncomingButton!: Button;
	private baseToggleButton!: Button;
	private layoutToggleButton!: Button;
	private progressNode!: HTMLSpanElement;
	private model: MergeEditorModel | undefined;
	private showBase = false;
	private columnLayout = false;
	private activeHunk = 0;
	private syncingScroll = false;
	private pendingActionFocus: { readonly index: number; readonly action: MergeEditorChoice | 'markHandled' | 'markUnhandled'; } | undefined;

	constructor(
		public readonly resultEditor: MergeResultEditor,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(resultEditor);
	}

	public create(container: HTMLElement): void {
		this.alignmentScheduler = this._register(new AnimationFrameScheduler(getWindow(container), () => {
			if (!this.model?.isReady) return;
			this.renderZones();
			this.synchronizeScroll('current', { scrollTopChanged: true, scrollLeftChanged: false });
		}));
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
			onClick: () => this.navigate(-1, false),
		}));
		this.nextButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.nextConflict' }, 'Next Conflict'),
			onClick: () => this.navigate(1, false),
		}));
		this.previousUnresolvedButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.previousUnresolvedConflict' }, 'Previous Unresolved'),
			onClick: () => this.navigate(-1, true),
		}));
		this.nextUnresolvedButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.nextUnresolvedConflict' }, 'Next Unresolved'),
			onClick: () => this.navigate(1, true),
		}));
		this.acceptRemainingCurrentButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.acceptRemainingCurrent' }, 'Accept Remaining Current'),
			onClick: () => this.acceptRemaining('current'),
		}));
		this.acceptRemainingIncomingButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.acceptRemainingIncoming' }, 'Accept Remaining Incoming'),
			onClick: () => this.acceptRemaining('incoming'),
		}));
		this.baseToggleButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.showBase' }, 'Show Base'),
			checked: false,
			onClick: () => { this.showBase = !this.showBase; this.updateLayout(); },
		}));
		this.layoutToggleButton = this._register(new Button(navigation, {
			label: localize({ bundle: 'ash', key: 'git.useColumns' }, 'Use Columns'),
			checked: false,
			onClick: () => { this.columnLayout = !this.columnLayout; this.updateLayout(); },
		}));
		this.progressNode = h(document, 'span');
		this.progressNode.className = 'ash-merge-progress';
		this.progressNode.setAttribute('role', 'status');
		this.progressNode.setAttribute('aria-live', 'polite');
		navigation.append(this.progressNode);
		const inputs = h(document, 'div');
		inputs.className = 'ash-merge-inputs';
		for (const side of ['base', 'current', 'incoming'] as const) {
			const section = h(document, 'section');
			section.className = `ash-merge-input ash-merge-input-${side}`;
			if (side === 'base') this.baseSection = section;
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
			const layout = this._register(new AnimationFrameScheduler(getWindow(editorNode), () => {
				editor.layout({ width: editorNode.clientWidth, height: editorNode.clientHeight });
			}));
			// Editor layout writes geometry; run it after the ResizeObserver delivery.
			this._register(observeElementSize(editorNode, () => layout.schedule()));
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
		const resultLayout = this._register(new AnimationFrameScheduler(getWindow(this.resultDomNode), () => {
			this.resultEditor.layout({ width: this.resultDomNode.clientWidth, height: this.resultDomNode.clientHeight });
		}));
		this._register(observeElementSize(this.resultDomNode, () => resultLayout.schedule()));
		this.updateLayout();
		this.updateNavigation();
	}

	public setModel(model: MergeEditorModel): void {
		this.clearZones();
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
			this.trackEditorGeometry(editor, store);
		}
		const resultControl = this.resultEditor.getControl();
		if (!resultControl) throw new Error('Merge result editor is not loaded');
		store.add(resultControl.onDidScrollChange(event => this.synchronizeScroll('result', event)));
		this.trackEditorGeometry(resultControl, store);
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
		this.alignmentScheduler.cancel();
		this.clearZones();
		for (const editor of this.sourceEditors.values()) editor.setModel(null);
		this.session.clear();
		this.model = undefined;
		this.resultEditor.clearInput();
		this.hunkButtons.clear();
		this.hunkActionButtons.length = 0;
		this.hunksDomNode?.replaceChildren();
		this.activeHunk = 0;
		this.pendingActionFocus = undefined;
		this.updateNavigation();
	}

	public layout(_dimension: IDimension): void {
		for (const [side, editor] of this.sourceEditors) {
			const node = this.sourceNodes.get(side)!;
			editor.layout({ width: node.clientWidth, height: node.clientHeight });
		}
		this.resultEditor.layout({ width: this.resultDomNode.clientWidth, height: this.resultDomNode.clientHeight });
	}

	private updateLayout(): void {
		this.domNode.classList.toggle('show-base', this.showBase);
		this.domNode.classList.toggle('columns', this.columnLayout);
		this.baseSection.hidden = !this.showBase;
		this.baseToggleButton.label = this.showBase
			? localize({ bundle: 'ash', key: 'git.hideBase' }, 'Hide Base')
			: localize({ bundle: 'ash', key: 'git.showBase' }, 'Show Base');
		this.baseToggleButton.checked = this.showBase;
		this.layoutToggleButton.label = this.columnLayout
			? localize({ bundle: 'ash', key: 'git.useStacked' }, 'Use Stacked Layout')
			: localize({ bundle: 'ash', key: 'git.useColumns' }, 'Use Columns');
		this.layoutToggleButton.checked = this.columnLayout;
		this.layout({ width: this.domNode.clientWidth, height: this.domNode.clientHeight });
		if (this.model?.isReady) {
			this.renderZones();
			this.synchronizeScroll('current', { scrollTopChanged: true, scrollLeftChanged: false });
		}
	}

	private trackEditorGeometry(editor: MergeGeometryEditor, store: DisposableStore): void {
		let layout = editor.getLayoutInfo();
		store.add(editor.onDidChangeConfiguration(() => this.alignmentScheduler.schedule()));
		store.add(editor.onDidLayoutChange(next => {
			if (sameLineGeometry(layout, next)) return;
			layout = next;
			this.alignmentScheduler.schedule();
		}));
	}

	public setVisible(visibility: boolean): void {
		this.domNode.hidden = !visibility;
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

	private navigate(step: number, unresolvedOnly: boolean): void {
		const hunks = this.model?.hunks.filter(hunk => !unresolvedOnly || hunk.unresolved);
		if (!hunks?.length) return;
		const next = step > 0
			? hunks.find(hunk => hunk.index > this.activeHunk) ?? hunks[0]
			: [...hunks].reverse().find(hunk => hunk.index < this.activeHunk) ?? hunks.at(-1)!;
		this.activeHunk = next.index;
		this.revealHunk(next);
	}

	private revealHunk(hunk: MergeEditorHunk): void {
		const resultControl = this.resultEditor.getControl();
		const range = rangeForLines(this.model!.result, hunk.result);
		resultControl?.setSelection(range, 'mergeEditor');
		resultControl?.revealRange?.(range);
		for (const side of ['base', 'current', 'incoming'] as const) {
			if (side === 'base' && !this.showBase) continue;
			this.sourceEditors.get(side)!.revealRange(rangeForLines(this.model![side], hunk[side]));
		}
		for (const [index, row] of [...this.hunksDomNode.children].entries()) row.classList.toggle('active', index === hunk.index);
	}

	private renderHunks(): void {
		const model = this.model;
		if (!model) return;
		if (!model.isReady) {
			for (const button of this.hunkActionButtons) button.enabled = false;
			this.updateNavigation();
			return;
		}
		this.hunkButtons.clear();
		this.hunksDomNode.replaceChildren();
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
			state.textContent = hunk.unresolved ? resolutionLabel('unresolved') : resolutionLabel(hunk.resolution);
			row.append(state);
			this.hunksDomNode.append(row);
		}
		this.renderZones();
		this.updateNavigation();
		this.pendingActionFocus = undefined;
	}

	private renderZones(): void {
		const focusedButtonIndex = this.hunkActionButtons.findIndex(button => button.hasFocus());
		this.clearZones();
		const model = this.model;
		if (!model?.isReady) return;
		const sides: readonly MergeEditorSide[] = this.showBase ? ['base', 'current', 'incoming', 'result'] : ['current', 'incoming', 'result'];
		const specs = new Map<MergeEditorSide, MergeZone[]>(sides.map(side => [side, []]));
		const added = new Map<MergeEditorSide, number>(sides.map(side => [side, 0]));
		const actionHeight = 32;
		const changes = {
			current: model.getChanges('current'),
			incoming: model.getChanges('incoming'),
			result: model.getChanges('result'),
		};
		for (const hunk of model.hunks) {
			const top = Math.max(...sides.map(side => this.topForBoundary(this.editorFor(side)!, model[side], hunk[side].startLineNumber) + added.get(side)!));
			for (const side of sides) {
				const editor = this.editorFor(side)!;
				const currentTop = this.topForBoundary(editor, model[side], hunk[side].startLineNumber) + added.get(side)!;
				const gap = top - currentTop;
				if (gap > 0) {
					specs.get(side)!.push({ afterLineNumber: hunk[side].startLineNumber - 1, heightInPx: gap });
					added.set(side, added.get(side)! + gap);
				}
				specs.get(side)!.push({ afterLineNumber: hunk[side].startLineNumber - 1, heightInPx: actionHeight, hunkIndex: hunk.index });
				added.set(side, added.get(side)! + actionHeight);
			}
			for (const alignment of getAlignments(hunk, changes, sides)) {
				const positions = sides.flatMap(side => {
					const lineNumber = alignment[side];
					if (lineNumber === undefined) return [];
					const top = this.topForBoundary(this.editorFor(side)!, model[side], lineNumber) + added.get(side)!;
					return [{ side, lineNumber, top }];
				});
				const top = Math.max(...positions.map(position => position.top));
				for (const { side, lineNumber, top: currentTop } of positions) {
					const gap = top - currentTop;
					if (gap <= 0) continue;
					specs.get(side)!.push({ afterLineNumber: lineNumber - 1, heightInPx: gap });
					added.set(side, added.get(side)! + gap);
				}
			}
			const bottom = Math.max(...sides.map(side => this.bottomForRange(this.editorFor(side)!, model[side], hunk[side]) + added.get(side)!));
			for (const side of sides) {
				const gap = bottom - this.bottomForRange(this.editorFor(side)!, model[side], hunk[side]) - added.get(side)!;
				if (gap <= 0) continue;
				const lines = hunk[side];
				specs.get(side)!.push({ afterLineNumber: (lines.isEmpty ? lines.startLineNumber : lines.endLineNumberExclusive) - 1, heightInPx: gap });
				added.set(side, added.get(side)! + gap);
			}
		}
		let focusButton: Button | undefined;
		this.syncingScroll = true;
		try {
			for (const side of sides) {
				const ids: string[] = [];
				const editor = this.editorFor(side)!;
				editor.changeViewZones(accessor => {
					for (const spec of specs.get(side)!) {
						const node = h(this.domNode.ownerDocument, 'div');
						if (spec.hunkIndex !== undefined) {
							node.className = 'ash-merge-inline-actions';
							const button = this.renderZoneActions(node, side, model.hunks[spec.hunkIndex]);
							if (button) focusButton = button;
						} else {
							node.className = 'ash-merge-spacer';
						}
						ids.push(accessor.addZone({
							afterLineNumber: spec.afterLineNumber, heightInPx: spec.heightInPx, domNode: node,
							isAccessible: spec.hunkIndex !== undefined,
							// View zones start hidden. Restore keyboard focus only after the
							// editor paints the replacement actions into a visible zone.
							onDomNodeTop: () => {
								if (focusButton && node.contains(focusButton.domNode) && node.hasAttribute('data-visible-view-zone')) {
									focusButton.focus();
									focusButton = undefined;
								}
							},
						}));
					}
				});
				this.zoneIds.set(side, ids);
			}
		} finally {
			this.syncingScroll = false;
		}
		if (!focusButton && focusedButtonIndex >= 0) focusButton = this.hunkActionButtons[focusedButtonIndex];
	}

	private renderZoneActions(node: HTMLElement, side: MergeEditorSide, hunk: MergeEditorHunk): Button | undefined {
		node.setAttribute('role', 'group');
		node.setAttribute('aria-label', `${localize({ bundle: 'ash', key: 'git.mergeBlock' }, 'Conflict {0}', hunk.index + 1)} — ${sideLabel(side)}`);
		let focusButton: Button | undefined;
		const addAction = (choice: MergeEditorChoice, label: string): void => {
			const button = this.zoneButtons.add(new Button(node, { label, onClick: () => this.acceptHunk(hunk.index, choice) }));
			this.hunkActionButtons.push(button);
			if (this.pendingActionFocus?.index === hunk.index && this.pendingActionFocus.action === choice) focusButton = button;
		};
		switch (side) {
			case 'base': addAction('base', localize({ bundle: 'ash', key: 'git.useBase' }, 'Use Base')); break;
			case 'current': addAction('current', localize({ bundle: 'ash', key: 'git.acceptCurrent' }, 'Accept Current')); break;
			case 'incoming': addAction('incoming', localize({ bundle: 'ash', key: 'git.acceptIncoming' }, 'Accept Incoming')); break;
			case 'result': {
				const state = h(this.domNode.ownerDocument, 'span');
				state.className = 'ash-merge-inline-state';
				state.textContent = hunk.unresolved ? resolutionLabel('unresolved') : resolutionLabel(hunk.resolution);
				node.append(state);
				if (!this.showBase) addAction('base', localize({ bundle: 'ash', key: 'git.useBase' }, 'Use Base'));
				addAction('both', this.model!.canSmartCombine(hunk.index)
					? localize({ bundle: 'ash', key: 'git.acceptCombination' }, 'Accept Combination')
					: localize({ bundle: 'ash', key: 'git.acceptBoth' }, 'Accept Both'));
				if (!this.model!.canSmartCombine(hunk.index)) addAction('bothReversed', localize({ bundle: 'ash', key: 'git.acceptIncomingFirst' }, 'Accept Both (Incoming First)'));
				if (hunk.resolution !== 'unresolved') {
					const markHandled = !hunk.handled;
					const action = markHandled ? 'markHandled' : 'markUnhandled';
					const button = this.zoneButtons.add(new Button(node, {
						label: markHandled
							? localize({ bundle: 'ash', key: 'git.markHandled' }, 'Mark Handled')
							: localize({ bundle: 'ash', key: 'git.markUnhandled' }, 'Mark Unhandled'),
						onClick: () => this.setHandled(hunk.index, markHandled),
					}));
					this.hunkActionButtons.push(button);
					if (this.pendingActionFocus?.index === hunk.index && this.pendingActionFocus.action === action) focusButton = button;
				}
				break;
			}
		}
		return focusButton;
	}

	private topForBoundary(editor: MergeCodeEditor, model: TextModel, lineNumber: number): number {
		return lineNumber > model.getLineCount() ? editor.getBottomForLineNumber(model.getLineCount()) : editor.getTopForLineNumber(lineNumber);
	}

	private bottomForRange(editor: MergeCodeEditor, model: TextModel, range: LineRange): number {
		return range.isEmpty ? this.topForBoundary(editor, model, range.startLineNumber) : editor.getBottomForLineNumber(Math.min(range.endLineNumberExclusive - 1, model.getLineCount()));
	}

	private editorFor(side: MergeEditorSide): MergeCodeEditor | undefined {
		return side === 'result' ? this.resultEditor.getControl() : this.sourceEditors.get(side);
	}

	private clearZones(): void {
		this.syncingScroll = true;
		try {
			for (const [side, ids] of this.zoneIds) {
				const editor = this.editorFor(side);
				if (editor?.getModel()) editor.changeViewZones(accessor => { for (const id of ids) accessor.removeZone(id); });
			}
			this.zoneIds.clear();
			this.zoneButtons.clear();
			this.hunkActionButtons.length = 0;
		} finally {
			this.syncingScroll = false;
		}
	}

	private acceptHunk(index: number, choice: MergeEditorChoice): void {
		const model = this.model;
		if (!model?.isReady) return;
		this.pendingActionFocus = { index, action: choice };
		model.acceptHunk(index, choice);
		this.activeHunk = index;
	}

	private setHandled(index: number, handled: boolean): void {
		const model = this.model;
		if (!model?.isReady) return;
		this.pendingActionFocus = { index, action: handled ? 'markUnhandled' : 'markHandled' };
		model.setHandled(index, handled);
		this.activeHunk = index;
	}

	private acceptRemaining(choice: 'current' | 'incoming'): void {
		const model = this.model;
		if (!model?.isReady) return;
		model.acceptRemaining(choice);
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
			const decorations: IModelDeltaDecoration[] = [];
			const changes = side === 'base'
				? [...model.getChanges('current'), ...model.getChanges('incoming')]
				: model.getChanges(side);
			for (const change of changes) {
				const lines = side === 'base' ? change.original : change.modified;
				const isConflict = model.hunks.some(hunk => hunk[side].intersectsOrTouches(lines));
				if (!lines.isEmpty && !isConflict) decorations.push({
					range: rangeForLines(textModel, lines),
					options: { description: 'merge-nonconflicting-change', isWholeLine: true, className: side === 'base' ? 'ash-merge-line-base-change' : 'ash-merge-line-change' },
				});
				if (side === 'result' && isConflict) continue;
				for (const inner of change.innerChanges ?? []) {
					const range = side === 'base' ? inner.originalRange : inner.modifiedRange;
					if (!range.isEmpty()) decorations.push({
						range,
						options: { description: 'merge-inline-change', inlineClassName: side === 'base' ? 'ash-merge-inline-removed' : 'ash-merge-inline-inserted' },
					});
				}
			}
			for (const hunk of model.hunks) {
				if (hunk[side].isEmpty) continue;
				decorations.push({
					range: rangeForLines(textModel, hunk[side]),
					options: { description: 'merge-conflict', isWholeLine: true, className: hunk.unresolved ? 'ash-merge-line-unresolved' : 'ash-merge-line-resolved' },
				});
			}
			collections.get(side)?.set(decorations);
		}
	}

	private synchronizeScroll(source: MergeEditorSide, event: { readonly scrollTopChanged: boolean; readonly scrollLeftChanged: boolean; }): void {
		const model = this.model;
		if (!model?.isReady || this.syncingScroll || (source === 'base' && !this.showBase)) return;
		const sourceEditor = source === 'result' ? this.resultEditor.getControl() : this.sourceEditors.get(source);
		if (!sourceEditor) return;
		this.syncingScroll = true;
		try {
			const topLine = sourceEditor.getVisibleRanges()[0]?.startLineNumber ?? 1;
			// Conflict view zones share pixel coordinates; line mappings apply between conflicts.
			const isAlignedConflict = model.hunks.some(hunk => hunk[source].contains(topLine));
			for (const side of ['base', 'current', 'incoming', 'result'] as const) {
				if (side === 'base' && !this.showBase) continue;
				if (side === source) continue;
				const target = side === 'result' ? this.resultEditor.getControl() : this.sourceEditors.get(side);
				if (!target) continue;
				if (event.scrollTopChanged) {
					let targetTop = sourceEditor.getScrollTop();
					if (!isAlignedConflict) {
						const mapping = model.getLineMapping(source, side).project(topLine);
						const sourceStart = this.topForBoundary(sourceEditor, model[source], mapping.inputRange.startLineNumber);
						const sourceEnd = this.topForBoundary(sourceEditor, model[source], mapping.inputRange.endLineNumberExclusive);
						const targetStart = this.topForBoundary(target, model[side], mapping.outputRange.startLineNumber);
						const targetEnd = this.topForBoundary(target, model[side], mapping.outputRange.endLineNumberExclusive);
						const fraction = Math.min(1, (sourceEditor.getScrollTop() - sourceStart) / (sourceEnd - sourceStart));
						targetTop = targetStart + (targetEnd - targetStart) * fraction;
					}
					target.setScrollTop(targetTop);
				}
				if (event.scrollLeftChanged) target.setScrollLeft(sourceEditor.getScrollLeft());
			}
		} finally {
			this.syncingScroll = false;
		}
	}

	private updateNavigation(): void {
		if (!this.previousButton || !this.nextButton) return;
		const enabled = Boolean(this.model?.isReady && this.model.hunks.length > 0);
		this.previousButton.enabled = enabled;
		this.nextButton.enabled = enabled;
		const hasUnresolved = Boolean(this.model?.isReady && this.model.unresolvedCount > 0);
		this.previousUnresolvedButton.enabled = hasUnresolved;
		this.nextUnresolvedButton.enabled = hasUnresolved;
		this.acceptRemainingCurrentButton.enabled = hasUnresolved;
		this.acceptRemainingIncomingButton.enabled = hasUnresolved;
		const total = this.model?.isReady ? this.model.hunks.length : 0;
		const resolved = total - (this.model?.unresolvedCount ?? 0);
		this.progressNode.textContent = localize({ bundle: 'ash', key: 'git.mergeProgress' }, '{0} of {1} conflicts resolved', resolved, total);
	}
}

function sideLabel(side: MergeEditorSide): string {
	switch (side) {
		case 'base': return localize({ bundle: 'ash', key: 'git.mergeBase' }, 'Base');
		case 'current': return localize({ bundle: 'ash', key: 'git.mergeCurrent' }, 'Current');
		case 'incoming': return localize({ bundle: 'ash', key: 'git.mergeIncoming' }, 'Incoming');
		case 'result': return localize({ bundle: 'ash', key: 'git.mergeResult' }, 'Result');
	}
}

function resolutionLabel(resolution: MergeEditorHunk['resolution']): string {
	switch (resolution) {
		case 'unresolved': return localize({ bundle: 'ash', key: 'git.mergeUnresolvedState' }, 'Unresolved');
		case 'base': return localize({ bundle: 'ash', key: 'git.mergeResolvedBase' }, 'Base');
		case 'current': return localize({ bundle: 'ash', key: 'git.mergeResolvedCurrent' }, 'Current accepted');
		case 'incoming': return localize({ bundle: 'ash', key: 'git.mergeResolvedIncoming' }, 'Incoming accepted');
		case 'both': return localize({ bundle: 'ash', key: 'git.mergeResolvedBoth' }, 'Both accepted');
		case 'bothReversed': return localize({ bundle: 'ash', key: 'git.mergeResolvedBothReversed' }, 'Both accepted, incoming first');
		case 'manual': return localize({ bundle: 'ash', key: 'git.mergeManualResolution' }, 'Manual resolution');
	}
}

function rangeForLines(model: TextModel, lines: LineRange): Range {
	const start = Math.min(lines.startLineNumber, model.getLineCount());
	const end = Math.min(lines.endLineNumberExclusive, model.getLineCount());
	return new Range(start, 1, end, lines.endLineNumberExclusive > model.getLineCount() ? model.getLineMaxColumn(end) : 1);
}

function sameLineGeometry(previous: EditorLayoutInfo, next: EditorLayoutInfo): boolean {
	return previous.width === next.width
		&& previous.contentWidth === next.contentWidth
		&& previous.wrappingColumn === next.wrappingColumn;
}
