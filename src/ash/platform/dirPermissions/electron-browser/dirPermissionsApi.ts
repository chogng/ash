import type { ConfigCommandResult, DirPermissionsForgetParams, DirPermissionsListResult, DirPermissionsReadParams, DirPermissionsReadResult, DirPermissionsSetParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";
import { invoke } from "../../ipc/electron-browser/rendererIpc.js";
import type { IDirPermissionsApi } from "../common/dirPermissionsApi.js";

export function createDirPermissionsApi(): IDirPermissionsApi {
	return {
		list: () => invoke<DirPermissionsListResult>("ash:dir-permissions:list"),
		read: params => invoke<DirPermissionsReadResult>("ash:dir-permissions:read", params as DirPermissionsReadParams),
		set: params => invoke<ConfigCommandResult>("ash:dir-permissions:set", params as DirPermissionsSetParams),
		forget: params => invoke<ConfigCommandResult>("ash:dir-permissions:forget", params as DirPermissionsForgetParams),
	};
}
