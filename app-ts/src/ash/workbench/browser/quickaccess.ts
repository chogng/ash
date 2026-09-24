import {
	RawContextKey,
} from "../../platform/contextkey/common/contextkey.js";

/** Whether a Workbench Quick Input control is currently active. */
export const InQuickInputContext =
	new RawContextKey<boolean>("inQuickInput", false);
