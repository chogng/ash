import type { ConfigCommandResult, DirPermissionsForgetParams, DirPermissionsListResult, DirPermissionsReadParams, DirPermissionsReadResult, DirPermissionsSetParams } from "../../app-server/common/generated/index.js";

/** Transport-only directory-permission management operations. */
export interface IDirPermissionsApi {
	list(): Promise<DirPermissionsListResult>;
	read(params: DirPermissionsReadParams): Promise<DirPermissionsReadResult>;
	set(params: DirPermissionsSetParams): Promise<ConfigCommandResult>;
	forget(params: DirPermissionsForgetParams): Promise<ConfigCommandResult>;
}
