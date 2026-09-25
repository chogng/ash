import { registerColor, transparent } from "../../../../platform/theme/common/colorUtils.js";
import { editorForeground } from "../../../../platform/theme/common/colors/editorColors.js";

const owner = "workbench.pdf";

export const pdfPageShadow = registerColor("pdf.pageShadow", {
	dark: transparent(editorForeground, 0.22),
	light: transparent(editorForeground, 0.22),
	highContrastDark: null,
	highContrastLight: null,
}, { description: "Shadow around a PDF page.", owner, needsTransparency: true });

export const pdfAnnotationNoteShadow = registerColor("pdf.annotationNoteShadow", {
	dark: transparent(editorForeground, 0.35),
	light: transparent(editorForeground, 0.35),
	highContrastDark: null,
	highContrastLight: null,
}, { description: "Shadow around a PDF annotation note.", owner, needsTransparency: true });
