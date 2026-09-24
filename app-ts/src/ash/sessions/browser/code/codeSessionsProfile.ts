import { createSessionsProfile } from "../../common/sessionsProfile.js";
import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";

/** Dedicated agent-session window for the Code Workbench mode. */
export const codeSessionsProfile = createSessionsProfile({
	id: "code-sessions",
	modeId: WorkbenchModeId.Code,
	label: "Code Sessions",
	titlebarActionId: "ash.code.open-sessions",
	workbenchRelativePath: "../workbench/workbench.html",
});
