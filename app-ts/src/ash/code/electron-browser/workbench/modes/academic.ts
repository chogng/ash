import "../../../browser/workbench/modes/academic.contribution.js";
import "../../../../sessions/contrib/providers/appServer/browser/workbenchSessionsService.contribution.js";
import "../../../../sessions/browser/workbenchChat.contribution.js";
import "../../../../sessions/browser/turnMultiDiffSource.contribution.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { main } from "../../../../workbench/electron-browser/desktop.main.js";

await main(WorkbenchModeId.Academic);
