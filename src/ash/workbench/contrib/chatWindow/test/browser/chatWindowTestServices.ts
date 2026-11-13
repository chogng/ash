import { Event } from '../../../../../base/common/event.js';
import type { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { createDisconnectedAppServerApi } from '../../../../../platform/agentHost/browser/appServerApi.js';
import { unavailableOperation } from '../../../../../platform/agentHost/browser/disconnectedAppServer.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { EditorParts, IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { BrowserTitleService } from '../../../../browser/parts/titlebar/titlebarPart.js';
import { IAuxiliaryWindowService } from '../../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { ITitleService } from '../../../../services/title/browser/titleService.js';

export function registerTestChatWindowParts(lifetime: DisposableStore, services: InstantiationService, root: HTMLElement, auxiliary: IAuxiliaryWindowService): void {
	if (!services.has(IAuxiliaryWindowService)) services.registerInstance(IAuxiliaryWindowService, auxiliary);
	if (!services.has(IAppServerApi)) services.registerInstance(IAppServerApi, createDisconnectedAppServerApi(unavailableOperation));
	if (!services.has(ITitleService)) services.registerSingleton(ITitleService, () => services.createInstance(BrowserTitleService, root, 'Ash', () => ({
		onMenubarVisibilityChange: Event.None,
		updateProperties() { },
		registerVariables() { },
		dispose() { },
		[Symbol.dispose]() { },
	}), undefined));
	services.registerSingleton(IEditorPartsService, accessor => {
		const main = lifetime.add(services.createInstance(EditorPart, root, {}));
		return services.createInstance(EditorParts, main, auxiliary, undefined, accessor.get(IAccessibilityService), accessor.get(IStorageService));
	});
}
