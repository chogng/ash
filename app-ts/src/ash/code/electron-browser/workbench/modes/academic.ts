import "../../../browser/workbench/modes/academic.contribution.js";
import "../../../../sessions/browser/workbenchSessions.contribution.js";
import { WorkbenchModeId } from "../../../../workbench/common/workbenchMode.js";
import { main } from "../../../../workbench/electron-browser/desktop.main.js";

performance.mark('ash.desktop.contributions-ready');
await main(WorkbenchModeId.Academic);
