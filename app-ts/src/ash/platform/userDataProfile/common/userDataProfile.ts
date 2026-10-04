import type { URI } from '../../../base/common/uri.js';

/** Current UI profile resources; their location follows the UI host. */
export interface IUserDataProfile {
	readonly id: string;
	readonly isDefault: boolean;
	readonly name: string;
	readonly location: URI;
	readonly keybindingsResource: URI;
}
