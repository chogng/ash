import { addDisposableListener, stopEvent } from "../../../../base/browser/dom.js";
import { isCancellationError } from "../../../../base/common/errors.js";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Selection } from "../../../common/core/selection.js";
import { type Range } from "../../../common/core/range.js";
import { type TextSnapshot } from "../../../common/core/textChange.js";
import { type View } from "../../../browser/view.js";
import { expandSmartSelection } from "../common/smartSelectionExpansion.js";
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent } from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

/** Routes the editor smart-select shortcut into the DOM-free range expansion policy. */
export class SmartSelectController extends Disposable {
	private readonly history: Array<readonly Selection[]> = [];
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Stanza smart select dependencies must share a text model");
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event), true));
		this._register(editor.onDidChangeCursorSelection(event => {
			if (event.source !== 'editor.action.smartSelect.expand' && event.source !== 'editor.action.smartSelect.shrink') {
				this.reset();
			}
		}));
		this._register(toDisposable(() => this.reset()));
		this._register(viewport.textModel.onDidChangeContent(() => this.reset()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.reset()));
		this._register(viewport.textModel.onWillDispose(() => this.reset()));
		this._register(languageFeatures.selectionRangeProvider.onDidChange(() => this.reset()));
		this._register(editor.onDidBlurEditorWidget(() => this.reset()));
	}

	private reset(): void {
		this.request?.abort();
		this.request = undefined;
		this.history.length = 0;
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey) || !event.shiftKey) return;
		if (event.key === "ArrowRight") {
			stopEvent(event, { immediate: true });
			const before = this.editor.getSelections()!;
			this.request?.abort();
			this.request = undefined;
			if (before.every(selection => selection.isEmpty())) {
				this.commitExpansion(before, this.viewport.textModel.createVersionedSnapshot(), []);
				return;
			}
			const request = this.request = new AbortController();
			const snapshot = this.viewport.textModel.createVersionedSnapshot();
			void this.expand(request, before, snapshot);
		} else if (event.key === "ArrowLeft") {
			stopEvent(event, { immediate: true });
			this.request?.abort();
			this.request = undefined;
			const previous = this.history.pop();
			if (previous) this.editor.setSelections(previous, 'editor.action.smartSelect.shrink');
			this.viewport.revealPosition(this.editor.getSelections()![0]!.getPosition());
		}
	}

	private async expand(request: AbortController, before: readonly Selection[], snapshot: TextSnapshot): Promise<void> {
		const model = this.viewport.textModel;
		const context = Object.freeze({
			...createLanguageFeatureRequest(model, model.getLanguageId(), request.signal),
			resource: model.uri,
			ranges: Object.freeze([...before]),
		});
		const syntaxRanges: Range[] = [];
		try {
			for (const provider of this.languageFeatures.selectionRangeProvider.ordered(model)) {
				if (!isLanguageFeatureRequestCurrent(context)) {
					return;
				}
				try {
					syntaxRanges.push(...await provider.provideSelectionRanges(context, request.signal));
				} catch (error) {
					if (!request.signal.aborted && !isCancellationError(error)) {
						this.onError(error);
					}
				}
			}
			if (isLanguageFeatureRequestCurrent(context) && this.request === request) {
				this.commitExpansion(before, snapshot, syntaxRanges);
			}
		} finally {
			if (this.request === request) {
				this.request = undefined;
			}
		}
	}

	private commitExpansion(before: readonly Selection[], snapshot: TextSnapshot, syntaxRanges: readonly Range[]): void {
		if (this.viewport.textModel.version !== snapshot.version || !Selection.selectionsArrEqual(this.editor.getSelections()!, [...before])) return;
		this.history.push(before);
		this.editor.setSelections(
			before.map(selection => expandSmartSelection(this.viewport.textModel, selection, syntaxRanges)),
			'editor.action.smartSelect.expand',
		);
		this.viewport.revealPosition(this.editor.getSelections()![0]!.getPosition());
	}
}

registerEditorContribution({
	id: "editor.contrib.smartSelect",
	install: context => {
		if (context.kind !== "text") return;
		return context.instantiationService.createInstance(SmartSelectController,
			context.controller.element,
			context.editor,
			context.view,
			context.onLanguageError,
		);
	},
});
