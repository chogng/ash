import { AbstractCodeEditorService } from '../../../../editor/browser/services/abstractCodeEditorService.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';

export class CodeEditorService extends AbstractCodeEditorService {
	constructor(@IEditorPartsService private readonly editorParts: IEditorPartsService) {
		super();
	}

	public getActiveCodeEditor(): ICodeEditor | null {
		const control = this.editorParts.activePane?.getControl?.();
		return this.listCodeEditors().find(editor => editor === control) ?? null;
	}
}
