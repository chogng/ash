import type { ConfigCommandResult, DirPermissionsForgetParams, DirPermissionsListResult, DirPermissionsReadParams, DirPermissionsReadResult, DirPermissionsSetParams } from "../../../../../crates/app-server-protocol/schema/typescript/index.js";

/** Transport-only directory-permission management operations. */
export interface IDirPermissionsApi {
	list(): Promise<DirPermissionsListResult>;
	read(params: DirPermissionsReadParams): Promise<DirPermissionsReadResult>;
	set(params: DirPermissionsSetParams): Promise<ConfigCommandResult>;
	forget(params: DirPermissionsForgetParams): Promise<ConfigCommandResult>;
}
