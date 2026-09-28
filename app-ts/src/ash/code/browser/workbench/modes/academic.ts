import "./academic.contribution.js";
import "../../../../sessions/contrib/providers/appServer/browser/workbenchSessionsService.contribution.js";
import "../../../../sessions/browser/workbenchChat.contribution.js";
import "../../../../sessions/browser/turnMultiDiffSource.contribution.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { startBrowserWorkbench } from "../../../../workbench/browser/web.bootstrap.js";

startBrowserWorkbench(WorkbenchModeId.Academic);
