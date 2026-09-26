import { WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../common/codeSessionsProfile.js";
import '../../../sessions/sessions.desktop.main.js';
import { main } from "../../../sessions/electron-browser/sessions.main.js";

await main(WorkbenchModeId.Code, codeSessionsProfile);
