import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICanvasContextService, ICanvasService } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { SessionCanvasContextService, SessionCanvasRegistryService } from './sessionCanvasService.js';
import { ISessionCanvasRegistryService } from '../common/sessionCanvas.js';
import { registerSessionCanvasActions } from './sessionCanvasActions.js';
import { EditorInputSerializers } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IPinnedCanvasService } from '../browser/pinnedCanvases.js';
import { PinnedCanvasService } from '../browser/pinnedCanvasService.js';
import { PinnedCanvasPageContribution } from './pinnedCanvasPage.js';
import { RemoteCanvasHostContribution } from './remoteCanvasHost.js';
import { registerPinnedCanvasSidebar } from './pinnedCanvasActions.js';
import { SessionCanvasSerializer } from './sessionCanvasSerializer.js';

registerSingleton(IPinnedCanvasService, PinnedCanvasService, InstantiationType.Delayed);
registerSingleton(ICanvasContextService, SessionCanvasContextService, InstantiationType.Delayed);
registerSingleton(ISessionCanvasRegistryService, SessionCanvasRegistryService, InstantiationType.Delayed);

registerWorkbenchContribution('sessions.contrib.canvases', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	resources.add(accessor.get(IInstantiationService).createInstance(PinnedCanvasPageContribution));
	resources.add(registerPinnedCanvasSidebar(accessor.get(IPinnedCanvasService), accessor.get(INotificationService)));
	resources.add(EditorInputSerializers.register(accessor.get(IInstantiationService).createInstance(SessionCanvasSerializer)));
	resources.add(registerSessionCanvasActions(accessor.get(ICanvasService), accessor.get(ISessionCanvasRegistryService), accessor.get(ICanvasContextService)));
	return resources;
});
import '../../../../workbench/contrib/canvases/electron-browser/canvases.contribution.js';

registerWorkbenchContribution('sessions.contrib.remoteCanvases', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(RemoteCanvasHostContribution));
