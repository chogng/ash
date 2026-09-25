import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { QuickAccessRegistry } from "../../../../platform/quickinput/common/quickAccess.js";
import { localize } from "../../../../nls.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { IStatusbarService } from "../../../services/statusbar/browser/statusbar.js";
import { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import "./editorActions.js";
import "./editorCommands.js";
import { EditorAutoSave } from "./editorAutoSave.js";
import { IEditorPart } from "./editorPart.js";
import { AllEditorsByMostRecentlyUsedQuickAccess } from "./editorQuickAccess.js";
import { EditorStatusContribution } from "./editorStatus.js";

QuickAccessRegistry.register({
	prefix: AllEditorsByMostRecentlyUsedQuickAccess.PREFIX,
	get placeholder() { return localize("workbench.editorQuickAccessPlaceholder", "Select an open editor"); },
	get helpLabel() { return localize("workbench.showAllEditors", "Show All Editors"); },
	ctor: AllEditorsByMostRecentlyUsedQuickAccess,
});

registerWorkbenchContribution(
	EditorStatusContribution.ID,
	WorkbenchPhase.AfterRestored,
	accessor => new EditorStatusContribution(
		accessor.get(IEditorPart),
		accessor.get(IStatusbarService),
	),
);

registerWorkbenchContribution(
	EditorAutoSave.ID,
	WorkbenchPhase.AfterRestored,
	accessor => new EditorAutoSave(
		accessor.get(IEditorPart),
		accessor.get(IWorkingCopyService),
		accessor.get(IConfigurationService),
	),
);
