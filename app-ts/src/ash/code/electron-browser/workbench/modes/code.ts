import "../../../browser/workbench/modes/code.contribution.js";
import "../../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { registerOpenAgentsWindowCommand } from "../../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindowCommand.js";
import { main } from "../../../../workbench/electron-browser/desktop.main.js";

registerOpenAgentsWindowCommand();
await main(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
