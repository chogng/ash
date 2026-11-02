import { formatNlsMessage, localize } from '../../../nls.js';
import type { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { createLabelKeybindingService } from '../../../platform/keybinding/test/common/keybindingTestUtils.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { ILocalizationService } from '../../services/localization/common/localizationService.js';
import { TestNotificationService } from '../../services/notification/test/common/testNotificationService.js';

/** Titlebar fixtures supply the shared menubar's window-owned services before construction. */
export function registerTestTitlebarServices(services: InstantiationService): InstantiationService {
	if (!services.has(ILocalizationService)) services.registerInstance(ILocalizationService, {
		whenReady: Promise.resolve(),
		translate: (bundle, key, fallback, parameters) => formatNlsMessage(localize({ bundle, key }, fallback), parameters),
	});
	if (!services.has(IKeybindingService)) services.registerInstance(IKeybindingService, createLabelKeybindingService());
	if (!services.has(INotificationService)) services.registerSingleton(INotificationService, () => new TestNotificationService());
	return services;
}
