import { h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { Range } from '../../../../common/core/range.js';
import type { DiffModel } from '../../../../common/diff/diffModel.js';
import { GlyphMarginLane } from '../../../../common/model.js';
import type { IGlyphMarginWidget } from '../../../editorBrowser.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';
import type { DiffEditorWidget } from '../diffEditorWidget.js';

/** Margin widgets use the editor's line geometry and share the diff widget's edit operations. */
export class RevertButtonsFeature extends Disposable {
	private readonly buttons = this._register(new DisposableStore());
	private enabled = false;

	constructor(private readonly editor: CodeEditorWidget, private readonly model: DiffModel, private readonly widget: DiffEditorWidget) {
		super();
		this._register(editor.onDidChangeCursorSelection(() => this.update(this.enabled)));
		this._register(onDidChangeNls(() => this.update(this.enabled)));
	}

	public update(enabled: boolean): void {
		this.enabled = enabled;
		this.buttons.clear();
		const diff = this.model.diff;
		if (!enabled || !diff || this.editor.getOption(EditorOption.readOnly)) return;
		const selections = this.editor.getSelections() ?? [];
		const selected = diff.changes.flatMap(change => (change.innerChanges ?? []).filter(range =>
			selections.some(selection => !selection.isEmpty() && Range.areIntersecting(selection, range.modifiedRange))));
		if (selected.length > 0) {
			this.addButton(selections.at(-1)!.positionLineNumber, 'selection', localize('diffEditor.revertSelection', 'Revert selected changes'), () => this.widget.revertRangeMappings(selected));
		}
		for (const [index, change] of diff.changes.entries()) {
			if (selected.some(range => change.innerChanges?.includes(range))) continue;
			const lineNumber = Math.min(this.model.modified.getLineCount(), change.modified.startLineNumber);
			this.addButton(lineNumber, String(index), localize('diffEditor.revertChange', 'Revert change'), () => this.widget.revert(change));
		}
	}

	private addButton(lineNumber: number, id: string, label: string, run: () => void): void {
		const container = h(this.editor.getDomNode().ownerDocument, 'div');
		container.className = 'ash-diff-revert';
		this.buttons.add(new Button(container, { label, icon: Lxicon.arrowLeft, iconOnly: true, size: 'small', onClick: run }));
		const widget: IGlyphMarginWidget = {
			getId: () => `diff-revert-${id}`,
			getDomNode: () => container,
			getPosition: () => ({ range: new Range(lineNumber, 1, lineNumber, 1), lane: GlyphMarginLane.Right, zIndex: 10 }),
		};
		this.editor.addGlyphMarginWidget(widget);
		this.buttons.add(toDisposable(() => this.editor.removeGlyphMarginWidget(widget)));
	}
}
