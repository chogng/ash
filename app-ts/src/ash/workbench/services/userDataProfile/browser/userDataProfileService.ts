import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import type { IUserDataProfileService } from '../common/userDataProfile.js';

/** Owns the UI profile identity independently of the connected workspace or backend. */
export class UserDataProfileService implements IUserDataProfileService {
	public readonly currentProfile = Object.freeze({
		id: 'default',
		isDefault: true,
		name: 'Default',
		location: URI.from({ scheme: Schemas.vscodeUserData, path: '/user' }),
		keybindingsResource: URI.from({ scheme: Schemas.vscodeUserData, path: '/user/keybindings.json' }),
	});
}
