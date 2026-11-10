import { extname } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';

const id = 'sessions.editor.pdfPreview';

registerEditorPane({
	id,
	get name() { return localize('sessions.pdfPreview.title', 'PDF Preview'); },
	canOpen: input => !isResourceDiffEditorInput(input) &&
		(input.contentType === 'application/pdf' || extname(input.resource.path).toLowerCase() === '.pdf')
		? EditorPaneMatch.Builtin : EditorPaneMatch.None,
	async create({ instantiationService }) {
		if (!instantiationService) throw new Error('PDF Preview requires Workbench instantiation services');
		const { PdfPreviewEditor } = await import('./pdfPreviewEditor.js');
		return instantiationService.createInstance(PdfPreviewEditor, id);
	},
});
