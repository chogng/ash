import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { SectionHeadersController } from "./sectionHeadersController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";

registerEditorContribution({ id: "editor.contrib.sectionHeaders", install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization || context.options.sectionHeaders === false) return;
	const options = context.options.sectionHeaders || {};
	context.register(new SectionHeadersController(
		context.view,
		context.model,
		context.languageId,
		context.configurations,
		context.getService(TextEditorCapability.languageLexicalContext),
		{
			findRegionSectionHeaders: options.showRegionSectionHeaders ?? true,
			findMarkSectionHeaders: options.showMarkSectionHeaders ?? true,
			markSectionHeaderRegex: options.markSectionHeaderRegex ?? "\\bMARK:\\s*(?<separator>-?)\\s*(?<label>.*)$",
		},
	));
} });
