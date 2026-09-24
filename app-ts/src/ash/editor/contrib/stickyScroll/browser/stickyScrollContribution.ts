import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { StickyScrollController } from "./stickyScrollController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { registerAction2 } from "../../../../platform/actions/common/actions.js";
import { FocusStickyScroll, GoToStickyScrollLine, SelectEditor, SelectNextStickyScrollLine, SelectPreviousStickyScrollLine, ToggleStickyScroll } from "./stickyScrollActions.js";

registerAction2(ToggleStickyScroll);
registerAction2(FocusStickyScroll);
registerAction2(SelectNextStickyScrollLine);
registerAction2(SelectPreviousStickyScrollLine);
registerAction2(GoToStickyScrollLine);
registerAction2(SelectEditor);

registerEditorContribution({ id: StickyScrollController.ID, install: context => {
	if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) {
		return;
	}
	const controller = context.instantiationService.createInstance(StickyScrollController, context.editor, context.view, context.getService(TextEditorCapability.folding), context.onLanguageError);
	void controller.stickyScrollCandidateProvider.update();
	return controller;
} });
