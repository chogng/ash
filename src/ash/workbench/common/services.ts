import type { INativeHostApi } from "../../platform/native/common/nativeHost.js";
import { createServiceIdentifier } from "../../platform/instantiation/common/instantiation.js";

/** Native window capabilities available only in Electron workbenches. */
export const INativeHostService =
	createServiceIdentifier<INativeHostApi>("nativeHostService");
