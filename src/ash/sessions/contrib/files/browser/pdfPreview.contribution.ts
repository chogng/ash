import { extname } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { isResourceDiffEditorInput } from '../../../../workbench/common/editor.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IPdfEditorService, PdfEditorService } from './pdfEditorService.js';

registerSingleton(IPdfEditorService, PdfEditorService, InstantiationType.Delayed);

const id = 'sessions.editor.pdfPreview';

registerEditorPane({
	id,
	get name() { return localize('sessions.pdfPreview.title', 'aspdf'); },
	resourceEditor: true,
	canOpen: input => !isResourceDiffEditorInput(input) &&
		(input.contentType === 'application/pdf' || extname(input.resource.path).toLowerCase() === '.pdf')
		? EditorPaneMatch.Default : EditorPaneMatch.None,
	async create({ instantiationService }) {
		if (!instantiationService) throw new Error('PDF Preview requires Workbench instantiation services');
		const { PdfPreviewEditor } = await import('./pdfPreviewEditor.js');
		return instantiationService.createInstance(PdfPreviewEditor, id);
	},
});
