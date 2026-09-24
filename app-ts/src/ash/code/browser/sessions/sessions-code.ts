import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../sessions/browser/code/codeSessionsProfile.js";
import { startBrowserSessions } from "../../../sessions/browser/webSessions.js";

startBrowserSessions(WorkbenchModeId.Code, codeSessionsProfile);
