import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { SectionHeadersController } from "./sectionHeadersController.js";

registerEditorContribution({ id: "editor.contrib.sectionHeaders", install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization || context.options.sectionHeaders === false) return;
	const options = context.options.sectionHeaders || {};
	return new SectionHeadersController(
		context.view,
		context.model,
		context.languageId,
		context.configurations,
		{
			findRegionSectionHeaders: options.showRegionSectionHeaders ?? true,
			findMarkSectionHeaders: options.showMarkSectionHeaders ?? true,
			markSectionHeaderRegex: options.markSectionHeaderRegex ?? "\\bMARK:\\s*(?<separator>-?)\\s*(?<label>.*)$",
		},
	);
} });
