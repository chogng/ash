import "../../../workbench/workbench.web.main.js";
import { resolveWorkbenchModeIdFromUrl, WorkbenchModeId } from "../../../workbench/common/workbenchMode.js";

declare const __ASH_WORKBENCH_MODE__: WorkbenchModeId;

const modeLoaders = {
	[WorkbenchModeId.Code]: () => import("./modes/code.js"),
	[WorkbenchModeId.Academic]: () => import("./modes/academic.js"),
} satisfies Record<WorkbenchModeId, () => Promise<unknown>>;

const modeId = resolveWorkbenchModeIdFromUrl(window.location.href, __ASH_WORKBENCH_MODE__);
await modeLoaders[modeId]();
