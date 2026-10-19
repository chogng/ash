import { registerEditorContribution } from '../../../registration.js';
import { TextEditorCapability } from '../../textEditorCapabilities.js';
import { addDisposableListener, stopEvent } from "../../../../../../src/ash/base/browser/dom.js";
import { Disposable } from "../../../../../../src/ash/base/common/lifecycle.js";
import { TextDecorationCollection } from "../../../../../../src/ash/editor/common/model/decorationCollection.js";
import { type LanguageDiagnostic } from '../../../../../../src/ash/editor/common/languages.js';
import { Selection } from "../../../../../../src/ash/editor/common/core/selection.js";
import { Position } from "../../../../../../src/ash/editor/common/core/position.js";
import { type Range } from "../../../../../../src/ash/editor/common/core/range.js";
import { type View } from "../../../../../../src/ash/editor/browser/view.js";
import { type IViewModel } from '../../../../../../src/ash/editor/common/viewModel.js';

/** Moves the primary selection through current-version diagnostics with F8. */
export class DiagnosticNavigationController extends Disposable {
	constructor(
		input: HTMLElement,
		private readonly viewport: View,
		private readonly viewModel: IViewModel,
		private readonly diagnostics: TextDecorationCollection<LanguageDiagnostic>,
	) {
		super();
		if (viewport.textModel !== viewModel.model || diagnostics.textModel !== viewModel.model) {
			this.dispose();
			throw new TypeError("Stanza diagnostic navigation dependencies must share one text model");
		}
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.key !== "F8") return;
		const diagnostics = this.diagnostics.decorations;
		if (diagnostics.length === 0) return;
		stopEvent(event);
		const active = this.viewModel.getSelections()[0]!.getPosition();
		const direction = event.shiftKey ? -1 : 1;
		const index = direction > 0
			? diagnostics.findIndex(diagnostic => Position.compare(diagnostic.range.getStartPosition(), active) > 0)
			: findPreviousDiagnostic(diagnostics, active);
		const target = diagnostics[index === -1 ? (direction > 0 ? 0 : diagnostics.length - 1) : index]!;
		this.viewModel.setSelections('editor.action.marker.next', [
			Selection.fromPositions(target.range.getStartPosition(), target.range.getEndPosition()),
		]);
		this.viewport.revealPosition(target.range.getStartPosition());
		this.viewport.announceAccessibilityStatus(describeDiagnostic(target.metadata));
	}
}

function describeDiagnostic(diagnostic: LanguageDiagnostic): string {
	const source = [diagnostic.source, diagnostic.code].filter(value => value !== undefined).join(" ");
	const prefix = source.length === 0 ? diagnostic.severity : `${diagnostic.severity} ${source}`;
	return `${prefix}: ${diagnostic.message}`;
}

function findPreviousDiagnostic(diagnostics: readonly { readonly range: Range; }[], active: Position): number {
	for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
		if (Position.compare(diagnostics[index]!.range.getEndPosition(), active) < 0) return index;
	}
	return -1;
}

registerEditorContribution({
	id: "editor.contrib.gotoError", install: context => {
		if (context.kind !== "text") return;
		return new DiagnosticNavigationController(
			context.controller.element,
			context.view,
			context.viewModel,
			context.getService(TextEditorCapability.diagnosticDecorations),
		);
	}
});
