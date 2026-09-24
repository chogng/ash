import "./code.contribution.js";
import { createAppServerDebugAdapterCapability } from "../../../../platform/debug/browser/appServerDebugAdapterProcessService.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { codeSessionsProfile } from "../../../../sessions/browser/code/codeSessionsProfile.js";
import { registerSessionsTitlebarEntry } from "../../../../sessions/browser/common/sessionTitlebarEntry.js";
import { startBrowserWorkbench } from "../../../../workbench/browser/web.bootstrap.js";

registerSessionsTitlebarEntry(codeSessionsProfile.titlebarActionId, "Open Code Sessions", { kind: "page", relativePath: "../sessions/sessions-code.html" });
startBrowserWorkbench(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);
