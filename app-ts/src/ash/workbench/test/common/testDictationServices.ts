import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../services/storage/browser/storageService.js';
import { DictationOnboardingService, IDictationOnboardingService } from '../../contrib/chat/browser/speechToText/dictationOnboarding.js';
import { IDictationService } from '../../../platform/dictation/common/dictationService.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../services/notification/common/notificationService.js';
import { ChatSpeechToTextService, IChatSpeechToTextService } from '../../contrib/chat/browser/speechToText/chatSpeechToTextService.js';

/** Test profile storage is isolated from the browser's persistent user profile. */
export function registerTestDictationServices(services: InstantiationService, backend: IDictationService | undefined, seen = true): void {
	services.registerInstance(IDictationService, backend);
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	if (!services.has(INotificationService)) {
		services.registerSingleton(INotificationService, () => new NotificationService());
	}
	if (!services.has(IStorageService)) {
		const entries = new Map<string, string>();
		services.registerSingleton(IStorageService, () => new BrowserStorageService({
			ownerWindow: window, applicationId: 'dictation-test', workspaceId: 'test', flushInterval: 0, backend: {
				get length() { return entries.size; }, clear: () => entries.clear(), key: index => [...entries.keys()][index] ?? null,
				getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: key => { entries.delete(key); },
			}
		}));
	}
	if (seen) services.get(IStorageService).store('dictation.introductionSeen', true, StorageScope.PROFILE, StorageTarget.USER);
	services.registerSingleton(IDictationOnboardingService, () => services.createInstance(DictationOnboardingService));
}
