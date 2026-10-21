import { h } from '../../../../../base/browser/dom.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { raceCancellationError, RunOnceScheduler } from '../../../../../base/common/async.js';
import { type CancellationToken, throwIfCancelled } from '../../../../../base/common/cancellation.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { onUnexpectedExternalError } from '../../../../../base/common/errors.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { OutlineModel, OutlineElement } from '../../../../../editor/contrib/documentSymbols/browser/outlineModel.js';
import { CodeEditorWidget } from '../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import type { IEditorOptions } from '../../../../../platform/editor/common/editor.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IEditorPane } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IOutlineService, type IOutline, type IOutlineCreator, type IOutlineListConfig, type OutlineChangeEvent, type OutlineTarget } from '../../../../services/outline/browser/outline.js';

/** Retains only a version-bound symbol result; the code editor continues to own its model and selection. */
class DocumentSymbolsOutline extends Disposable implements IOutline<OutlineElement> {
	public readonly outlineKind = 'documentSymbols';
	private model: OutlineModel | undefined;
	private readonly changed = this._register(new Emitter<OutlineChangeEvent>());
	public readonly onDidChange = this.changed.event;
	private readonly modelListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly request = this._register(new MutableDisposable());
	private readonly updateSoon = this._register(new RunOnceScheduler(() => void this.update().catch(onUnexpectedExternalError), 150));
	public readonly config: IOutlineListConfig<OutlineElement>;

	constructor(
		private readonly editor: CodeEditorWidget,
		@ILanguageFeaturesService private readonly features: ILanguageFeaturesService,
		@IEditorService private readonly editors: IEditorService,
	) {
		super();
		this.config = {
			treeDataSource: { getChildren: element => element === this ? this.roots() : (element as OutlineElement).children.values() },
			comparator: {
				compareByPosition: (a, b) => Range.compareRangesUsingStarts(a.symbol.range, b.symbol.range),
				compareByName: (a, b) => a.symbol.name.localeCompare(b.symbol.name),
				compareByType: (a, b) => (typeof a.symbol.kind === 'number' && typeof b.symbol.kind === 'number' ? a.symbol.kind - b.symbol.kind : String(a.symbol.kind).localeCompare(String(b.symbol.kind))) || a.symbol.name.localeCompare(b.symbol.name),
			},
			options: {
				modelOptions: { identityProvider: { getId: element => element.id }, defaultCollapseState: 'expanded' },
				keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.symbol.name },
				expandOnlyOnTwistieClick: true,
				renderElement: element => {
					const row = h(this.editor.getDomNode().ownerDocument, 'span');
					row.className = 'ash-outline-row';
					appendIcon(Lxicon.code, row);
					const label = h(row.ownerDocument, 'span');
					label.className = 'ash-outline-label';
					label.textContent = element.symbol.name;
					row.append(label);
					if (element.symbol.detail) {
						const detail = h(row.ownerDocument, 'span');
						detail.className = 'ash-outline-detail';
						detail.textContent = element.symbol.detail;
						row.append(detail);
					}
					return row;
				},
			},
		};
		this._register(editor.onDidChangeModel(() => {
			this.bindModel();
			this.updateSoon.schedule(0);
		}));
		this._register(editor.onDidChangeCursorPosition(() => this.changed.fire({ affectOnlyActiveElement: true })));
		this._register(features.documentSymbolProvider.onDidChange(() => this.updateSoon.schedule(0)));
		this.bindModel();
	}

	public get uri() { return this.editor.getModel()?.uri; }
	public get isEmpty(): boolean { return this.roots().length === 0; }

	public get activeElement(): OutlineElement | undefined {
		const position = this.editor.getPosition();
		if (!position) return undefined;
		let active: OutlineElement | undefined;
		const visit = (elements: Iterable<OutlineElement>): void => {
			for (const element of elements) {
				if (!element.symbol.range.containsPosition(position)) continue;
				active = element;
				visit(element.children.values());
			}
		};
		visit(this.roots());
		return active;
	}

	public async reveal(entry: OutlineElement, options: IEditorOptions, sideBySide: boolean, select: boolean): Promise<void> {
		const model = this.editor.getModel();
		if (!model || this.model?.version !== model.getVersionId()) return;
		const range = select ? entry.symbol.selectionRange : Range.fromPositions(entry.symbol.selectionRange.getStartPosition());
		await this.editors.openEditor({ resource: model.uri }, { ...options, selection: range, selectionSource: TextEditorSelectionSource.NAVIGATION }, sideBySide ? 'sideGroup' : 'activeGroup');
	}

	public async update(): Promise<void> {
		if (this.isDisposed) return;
		const controller = new AbortController();
		this.request.value = toDisposable(() => controller.abort());
		const model = this.editor.getModel();
		const outline = model instanceof TextModel
			? await OutlineModel.create(this.features.documentSymbolProvider, model, controller.signal, onUnexpectedExternalError)
			: null;
		if (this.isDisposed || controller.signal.aborted) return;
		this.model = outline ?? undefined;
		this.changed.fire({});
	}

	private roots(): OutlineElement[] {
		return [...(this.model?.children.values() ?? [])].flatMap(group => [...group.children.values()]);
	}

	private bindModel(): void {
		this.request.clear();
		this.model = undefined;
		const resources = new DisposableStore();
		this.modelListeners.value = resources;
		const model = this.editor.getModel();
		if (!model) return;
		resources.add(model.onDidChangeContent(() => {
			this.request.clear();
			this.updateSoon.schedule();
		}));
		resources.add(model.onDidChangeLanguage(() => this.updateSoon.schedule(0)));
		resources.add(model.onWillDispose(() => {
			this.request.clear();
			this.model = undefined;
			this.changed.fire({});
		}));
	}
}

/** Adapts text and diff editor controls to the shared outline creation contract. */
export class DocumentSymbolsOutlineCreator extends Disposable implements IOutlineCreator<IEditorPane, OutlineElement> {
	constructor(
		@IOutlineService outlineService: IOutlineService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this._register(outlineService.registerOutlineCreator(this));
	}

	public matches(candidate: IEditorPane): candidate is IEditorPane {
		const control = candidate.getControl();
		return control instanceof CodeEditorWidget || control instanceof DiffEditorWidget;
	}

	public async createOutline(pane: IEditorPane, target: OutlineTarget, token: CancellationToken): Promise<IOutline<OutlineElement> | undefined> {
		throwIfCancelled(token);
		const control = pane.getControl();
		const editor = control instanceof DiffEditorWidget ? control.modifiedEditor : control;
		if (!(editor instanceof CodeEditorWidget)) return undefined;
		const outline = this.instantiation.createInstance(DocumentSymbolsOutline, editor);
		using cancellation = token.onCancellationRequested(() => outline.dispose());
		try {
			await raceCancellationError(outline.update(), token);
			if (token.isCancellationRequested) { outline.dispose(); return undefined; }
			return outline;
		} catch (error) {
			outline.dispose();
			throw error;
		}
	}
}
