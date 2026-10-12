import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { invoke } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { WINDOW_SPLASH_SAVE_CHANNEL, type IPartsSplash } from '../../../../platform/theme/common/themeService.js';
import { ISplashStorageService } from '../browser/splash.js';

class SplashStorageService implements ISplashStorageService {
	saveWindowSplash(splash: IPartsSplash): Promise<void> {
		return invoke<void>(WINDOW_SPLASH_SAVE_CHANNEL, splash);
	}
}

registerSingleton(ISplashStorageService, SplashStorageService, InstantiationType.Delayed);
