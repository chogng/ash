import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../common/codeSessionsProfile.js";
import { startElectronSessions } from "../../../sessions/electron-browser/electronSessions.js";

await startElectronSessions(WorkbenchModeId.Code, codeSessionsProfile);
