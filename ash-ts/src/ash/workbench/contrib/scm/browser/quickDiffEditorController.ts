import './media/quickDiff.css';
import { addDisposableListener, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { type TextEditorContributionContext, type TextEditorRuntimeContribution } from '../../../../editor/browser/editorExtensions.js';
import { Position } from '../../../../editor/common/core/position.js';
import { LineDiffKind } from '../../../../editor/common/diff/lineDiff.js';
import { EditorPeekViewWidget } from '../../../../editor/contrib/peekView/browser/editorPeekViewWidget.js';
import { type IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { type IQuickDiffEditorController, type IQuickDiffEditorControllerService, type IQuickDiffModelService, type QuickDiffChange, type QuickDiffModelReference } from '../common/quickDiff.js';
import { ScmConfiguration } from '../common/scmConfiguration.js';
import { QuickDiffDecorator } from './quickDiffDecorator.js';

/** Per-editor Quick Diff controller created through constructor injection after first render. */
export class QuickDiffEditorController extends Disposable implements TextEditorRuntimeContribution, IQuickDiffEditorController {
	private readonly view = this._register(new MutableDisposable<QuickDiffPeekView>());
	private readonly modelReference: QuickDiffModelReference | undefined;
	private currentChange: QuickDiffChange | undefined;

	constructor(private readonly context: TextEditorContributionContext, private readonly configurationService: IConfigurationService, modelService: IQuickDiffModelService, controllerService: IQuickDiffEditorControllerService) {
		super();
		this.modelReference = this._register(modelService.createModelReference(context.options.input.resource, context.model));
		this._register(new QuickDiffDecorator(context.model, this.modelReference, configurationService));
		this._register(controllerService.register(this));
		this._register(addDisposableListener<FocusEvent>(context.view.domNode.domNode, 'focusin', () => controllerService.activate(this)));
		if (context.view.domNode.domNode.contains(context.view.domNode.domNode.ownerDocument.activeElement)) controllerService.activate(this);
		this._register(addDisposableListener<PointerEvent>(context.view.domNode.domNode, 'pointerdown', event => this.handlePointerDown(event), { capture: true }));
		this._register(addDisposableListener<KeyboardEvent>(context.view.domNode.domNode, 'keydown', event => this.handleKeyDown(event), { capture: true }));
		this._register(this.modelReference.object.onDidChange(() => this.handleModelChange()));
	}

	showNextChange(): void {
		const model = this.modelReference?.object;
		if (!model) return;
		const lineIndex = this.currentChange?.lineIndex ?? this.context.selectionController.getSelections()[0]!.getPosition().lineNumber - 1;
		const change = this.currentChange ? model.findNextChange(lineIndex) : model.findNextChange(lineIndex, true);
		if (change) this.showChange(change);
		else this.context.view.announceAccessibilityStatus('No Quick Diff changes');
	}

	showPreviousChange(): void {
		const model = this.modelReference?.object;
		if (!model) return;
		const lineIndex = this.currentChange?.lineIndex ?? this.context.selectionController.getSelections()[0]!.getPosition().lineNumber - 1;
		const change = this.currentChange ? model.findPreviousChange(lineIndex) : model.findPreviousChange(lineIndex, true);
		if (change) this.showChange(change);
		else this.context.view.announceAccessibilityStatus('No Quick Diff changes');
	}

	close(): void {
		this.currentChange = undefined;
		this.view.clear();
	}

	private handlePointerDown(event: PointerEvent): void {
		if (event.button !== 0 || this.configurationService.getValue(ScmConfiguration.diffDecorationsGutterAction) !== 'diff') return;
		if (!isHTMLElement(event.target) || !event.target.closest('.ash-quick-diff-gutter')) return;
		const target = this.context.view.getNearestTargetAtClientPoint({ clientX: event.clientX, clientY: event.clientY });
		if (!target) return;
		const change = this.modelReference?.object.findChangeAtLine(target.position.lineNumber - 1);
		if (!change) return;
		stopEvent(event);
		this.showChange(change);
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		if (event.key === 'Escape' && this.view.value) {
			stopEvent(event);
			this.close();
			return;
		}
	}

	private handleModelChange(): void {
		if (!this.currentChange) return;
		const model = this.modelReference?.object;
		const next = model?.findChangeAtLine(this.currentChange.lineIndex) ?? model?.findNextChange(this.currentChange.lineIndex, true);
		if (next) this.showChange(next);
		else this.close();
	}

	private showChange(change: QuickDiffChange): void {
		const model = this.modelReference?.object;
		if (!model) return;
		this.currentChange = change;
		this.context.view.revealPosition(new Position((change.lineIndex) + 1, (0) + 1));
		const index = model.state.changes.indexOf(change);
		this.view.value = new QuickDiffPeekView(
			this.context,
			change,
			Math.max(0, index) + 1,
			model.state.changes.length,
			() => this.showPreviousChange(),
			() => this.showNextChange(),
			() => this.close(),
		);
		this.context.view.announceAccessibilityStatus(`Quick Diff change ${Math.max(0, index) + 1} of ${model.state.changes.length}`);
	}
}

/** Tracks the last focused Quick Diff-capable editor for commands and keybindings. */
export class QuickDiffEditorControllerService extends Disposable implements IQuickDiffEditorControllerService {
	private readonly controllers = new Set<IQuickDiffEditorController>();
	private _activeController: IQuickDiffEditorController | undefined;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.controllers.clear();
			this._activeController = undefined;
		}));
	}

	get activeController(): IQuickDiffEditorController | undefined {
		return this._activeController;
	}

	register(controller: IQuickDiffEditorController) {
		this.assertNotDisposed();
		if (this.controllers.has(controller)) throw new RangeError('Quick Diff editor controller is already registered');
		this.controllers.add(controller);
		return toDisposable(() => {
			this.controllers.delete(controller);
			if (this._activeController === controller) this._activeController = undefined;
		});
	}

	activate(controller: IQuickDiffEditorController): void {
		this.assertNotDisposed();
		if (!this.controllers.has(controller)) throw new ReferenceError('Quick Diff editor controller is not registered');
		this._activeController = controller;
	}
}

class QuickDiffPeekView extends Disposable {
	constructor(context: TextEditorContributionContext, change: QuickDiffChange, index: number, count: number, showPrevious: () => void, showNext: () => void, close: () => void) {
		super();
		const document = context.view.domNode.domNode.ownerDocument;
		const kind = change.kind === LineDiffKind.Added ? 'Added' : change.kind === LineDiffKind.Removed ? 'Deleted' : 'Modified';
		const peek = this._register(new EditorPeekViewWidget(context.editor, new Position((change.lineIndex) + 1, (0) + 1), `${change.comparison.original.label} — ${kind} — ${index} of ${count}`));
		peek.element.classList.add('ash-quick-diff-peek');
		const body = h(document, 'div');
		body.className = 'ash-quick-diff-peek-body';
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-quick-diff-peek-toolbar';
		const previous = button(document, 'Previous change', '↑');
		const next = button(document, 'Next change', '↓');
		const closeButton = button(document, 'Close Quick Diff', '×');
		toolbar.append(previous, next, closeButton);
		const diffContainer = h(document, 'div');
		diffContainer.className = 'ash-quick-diff-peek-diff';
		body.append(toolbar, diffContainer);
		peek.setBody(body);
		this._register(addDisposableListener(previous, 'click', showPrevious));
		this._register(addDisposableListener(next, 'click', showNext));
		this._register(addDisposableListener(closeButton, 'click', close));
		const diffWidget = this._register(new DiffEditorWidget({
			container: diffContainer,
			model: change.comparison.model,
			codeEditorService: context.options.codeEditorService,
			lineHeight: context.options.lineHeight,
			fontFamily: context.options.fontFamily,
			fontSize: context.options.fontSize,
			fontLigatures: context.options.fontLigatures === true,
			showLineNumbers: context.options.lineNumbers === undefined ? undefined : context.options.lineNumbers !== 'off',
			originalAriaLabel: change.comparison.original.label,
			modifiedAriaLabel: context.options.input.label ?? context.options.input.resource.toString(),
		}));
		const reveal = (): void => {
			if (!change.comparison.model.diff) return;
			try {
				if (change.modifiedLineCount > 0) diffWidget.revealModifiedLine(change.modifiedStartLineIndex);
				else diffWidget.revealOriginalLine(change.originalStartLineIndex);
			} catch {
				// The live model may have advanced between selecting and projecting this hunk.
			}
		};
		this._register(change.comparison.model.onDidChange(reveal));
		reveal();
		peek.show();
	}
}

function button(document: Document, label: string, text: string): HTMLButtonElement {
	const element = h(document, 'button');
	element.type = 'button';
	element.className = 'ash-quick-diff-peek-action';
	element.setAttribute('aria-label', label);
	element.title = label;
	element.textContent = text;
	return element;
}
