import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../common/codeSessionsProfile.js";
import { startBrowserSessions } from "../../../sessions/browser/web.main.js";

startBrowserSessions(WorkbenchModeId.Code, codeSessionsProfile);
