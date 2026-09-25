import "./code.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../common/codeSessionsProfile.js";
import { registerOpenAgentsWindowBrowserCommand } from "../../../../sessions/contrib/openAgentsWindow/browser/openAgentsWindowCommand.js";
import { startBrowserWorkbench } from "../../../../workbench/browser/web.bootstrap.js";

registerOpenAgentsWindowBrowserCommand(codeSessionsProfile.titlebarActionId, "Open Code Sessions", "../sessions/sessions-code.html");
startBrowserWorkbench(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
