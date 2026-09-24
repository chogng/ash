import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../sessions/browser/code/codeSessionsProfile.js";
import { startElectronSessions } from "../../../sessions/electron-browser/electronSessions.js";

await startElectronSessions(WorkbenchModeId.Code, codeSessionsProfile);
