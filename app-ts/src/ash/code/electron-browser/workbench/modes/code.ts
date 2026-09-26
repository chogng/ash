import "../../../browser/workbench/modes/code.contribution.js";
import "../../../../sessions/contrib/openAgentsWindow/electron-browser/openAgentsWindow.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import "../../../../workbench/contrib/chat/electron-browser/chat.contribution.js";
import { main } from "../../../../workbench/electron-browser/desktop.main.js";

await main(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
