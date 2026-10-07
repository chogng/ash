import { AbstractCodeEditorService } from '../../../../editor/browser/services/abstractCodeEditorService.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { Range } from '../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../platform/editor/common/editor.js';

export class CodeEditorService extends AbstractCodeEditorService {
	constructor(@IEditorPartsService private readonly editorParts: IEditorPartsService) {
		super();
		this._register(this.registerCodeEditorOpenHandler(async (input, _source, sideBySide) => {
			const selection = input.options?.selection;
			const pane = await editorParts.openEditor({ resource: input.resource }, {
				pinned: input.options?.pinned,
				preserveFocus: input.options?.preserveFocus,
				ignoreError: input.options?.ignoreError,
				source: input.options?.source,
				selection: selection ? new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber ?? selection.startLineNumber, selection.endColumn ?? selection.startColumn) : undefined,
				selectionSource: TextEditorSelectionSource.NAVIGATION,
			}, sideBySide ? 'sideGroup' : 'activeGroup');
			const control = pane.getControl?.();
			const editor = this.listCodeEditors().find(editor => editor === control) ?? null;
			if (editor && !input.options?.preserveFocus) {
				editor.focus();
			}
			return editor;
		}));
	}

	public getActiveCodeEditor(): ICodeEditor | null {
		const control = this.editorParts.activePane?.getControl?.();
		return this.listCodeEditors().find(editor => editor === control) ?? null;
	}
}
