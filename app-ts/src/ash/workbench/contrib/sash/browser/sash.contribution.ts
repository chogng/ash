import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { ILayoutService } from "../../../../platform/layout/browser/layoutService.js";
import { registerWorkbenchContribution, WorkbenchPhase } from "../../../common/contributions.js";
import { SashSettingsController } from "./sash.js";

registerWorkbenchContribution(
	"workbench.contrib.sash",
	WorkbenchPhase.AfterRestored,
	(accessor) => new SashSettingsController(
		accessor.get(IConfigurationService),
		accessor.get(ILayoutService).mainContainer,
	),
);
