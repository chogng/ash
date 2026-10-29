import { Disposable } from '../../../../base/common/lifecycle.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, EditorContributionInstantiation, type ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { InlayHintsController } from '../../../../editor/contrib/inlayHints/browser/inlayHintsController.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';

/** Reads the existing hint projection without issuing another language-provider request. */
export class InlayHintsAccessibility extends Disposable {
	public static readonly ID = 'editor.contrib.InlayHintsAccessibility';

	constructor(
		private readonly editor: ICodeEditor,
		@ICodeEditorService codeEditors: ICodeEditorService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) {
		super();
		this._register(
			AccessibleViewRegistry.register({
				type: AccessibleViewType.View,
				priority: 110,
				name: `${InlayHintsAccessibility.ID}.${editor.getId()}`,
				when: EditorContextKeys.editorTextFocus.isEqualTo(true),
				getProvider: accessor => {
					if (accessor.get(ICodeEditorService) !== codeEditors || codeEditors.getFocusedCodeEditor() !== editor || editor.isSimpleWidget) {
						return undefined;
					}
					const model = editor.getModel();
					const line = editor.getPosition()?.lineNumber;
					const hints = InlayHintsController.get(editor);
					if (!model || line === undefined || !hints?.getInlayHintsForLine(line).length) {
						return undefined;
					}
					const provider = new AccessibleContentProvider(
						AccessibleViewProviderId.InlayHints,
						{ type: AccessibleViewType.View },
						() => {
							if (model.isDisposed() || editor.getModel() !== model || line > model.getLineCount()) {
								return '';
							}
							const text = model.getLineContent(line);
							let offset = 0;
							const parts: string[] = [];
							for (const hint of hints.getInlayHintsForLine(line)) {
								const column = Math.min(text.length, hint.position.column - 1);
								parts.push(text.slice(offset, column), ' ', typeof hint.label === 'string' ? hint.label : hint.label.map(part => part.value).join(''), ' ');
								offset = column;
							}
							parts.push(text.slice(offset));
							return localize('inlayHints.readLine', 'Line {0} with inlay hints:\n{1}', line, parts.join(''));
						},
						() => {
							if (!model.isDisposed() && editor.getModel() === model) editor.focus();
						},
						AccessibilityVerbositySettingId.InlayHints,
					);
					provider.onDidChangeContent = hints.onDidChangeHints;
					return provider;
				},
			}),
		);
	}

	public static get(editor: ICodeEditor): InlayHintsAccessibility | null {
		return editor.getContribution<InlayHintsAccessibility>(InlayHintsAccessibility.ID);
	}

	public startInlayHintsReading(): void {
		this.editor.focus();
		const line = this.editor.getPosition()?.lineNumber;
		if (line === undefined || !InlayHintsController.get(this.editor)?.getInlayHintsForLine(line).length) {
			status(localize('inlayHints.none', 'No inlay hints on the current line.'));
			return;
		}
		this.accessibleView.show(AccessibleViewType.View, this.editor.getDomNode() ?? undefined);
	}
}

registerEditorContribution(InlayHintsAccessibility.ID, InlayHintsAccessibility, EditorContributionInstantiation.AfterFirstRender);
registerEditorAction(
	class ReadInlayHints extends EditorAction {
		constructor() {
			super({
				id: 'inlayHints.startReadingLineWithHint',
				label: localize2('inlayHints.readTitle', 'Read Line with Inlay Hints'),
				precondition: undefined,
			});
		}

		public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
			InlayHintsAccessibility.get(editor)?.startInlayHintsReading();
		}
	},
);
