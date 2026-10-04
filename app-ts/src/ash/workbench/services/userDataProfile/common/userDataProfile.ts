import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IUserDataProfile } from '../../../../platform/userDataProfile/common/userDataProfile.js';

export interface IUserDataProfileService {
	readonly currentProfile: IUserDataProfile;
}

export const IUserDataProfileService = createDecorator<IUserDataProfileService>('userDataProfileService');
