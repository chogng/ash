import { onActivate } from '../../../browser/editorFeatureRegistration.js';
import { registerEditorContribution } from "../../../browser/editorFeatureRegistration.js";
import { StickyScrollController } from "./stickyScrollController.js";
import { TextEditorCapability } from "../../textEditorCapabilities.js";
import { registerAction2 } from "../../../../platform/actions/common/actions.js";
import { FocusStickyScroll, GoToStickyScrollLine, SelectEditor, SelectNextStickyScrollLine, SelectPreviousStickyScrollLine, ToggleStickyScroll } from "./stickyScrollActions.js";

onActivate(() => registerAction2(ToggleStickyScroll));
onActivate(() => registerAction2(FocusStickyScroll));
onActivate(() => registerAction2(SelectNextStickyScrollLine));
onActivate(() => registerAction2(SelectPreviousStickyScrollLine));
onActivate(() => registerAction2(GoToStickyScrollLine));
onActivate(() => registerAction2(SelectEditor));

registerEditorContribution({
	id: StickyScrollController.ID, install: context => {
		if (context.kind !== "text" || context.model.largeFile.tooLargeForTokenization) {
			return;
		}
		const controller = context.instantiationService.createInstance(StickyScrollController, context.editor, context.view, context.getService(TextEditorCapability.folding), context.onLanguageError);
		void controller.stickyScrollCandidateProvider.update();
		return controller;
	}
});
