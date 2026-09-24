import "./media/pdfEditor.css";
import { registerEditorPane } from "../../../browser/parts/editor/editorRegistry.js";
import { PdfEditorPane } from "./pdfEditorPane.js";
import { WorkspacePdfAnnotationStore } from "./pdfAnnotationStore.js";
import { PDF_EDITOR_ID, matchPdfEditor } from "./pdfEditorInput.js";
import { WorkspacePdfDocumentLoader } from "./pdfDocumentLoader.js";
import { PdfJsRenderer } from "./pdfRenderer.js";

registerEditorPane({
	id: PDF_EDITOR_ID,
	name: "PDF Reader",
	canOpen: matchPdfEditor,
	create: options => {
		if (!options.fileService) throw new Error("PDF Reader requires the Workbench file service");
		return new PdfEditorPane(
			new WorkspacePdfDocumentLoader(options.fileService),
			new WorkspacePdfAnnotationStore(options.fileService),
			new PdfJsRenderer(),
		);
	},
});
