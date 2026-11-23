import '../../../../workbench/contrib/canvases/electron-browser/canvases.contribution.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ICanvasContextService, ICanvasService } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { registerCanvasContextPicker } from '../../../../workbench/contrib/canvases/browser/canvasContextPicker.js';
import { SessionCanvasContextService, SessionCanvasRegistryService } from './sessionCanvasService.js';
import { ISessionCanvasRegistryService } from '../common/sessionCanvas.js';
import { NewCanvasSessionAction, registerSessionCanvasActions } from './sessionCanvasActions.js';
import { registerAction2 } from '../../../../platform/actions/common/actions.js';
import { EditorInputSerializers } from '../../../../workbench/services/editor/common/editorInputSerializer.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
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
	const canvases = accessor.get(ICanvasService);
	const newCanvasSession = resources.add(new MutableDisposable());
	resources.add(autorun(reader => {
		if (canvases.enabled.read(reader)) newCanvasSession.value ??= registerAction2(NewCanvasSessionAction);
		else newCanvasSession.clear();
	}));
	resources.add(accessor.get(IInstantiationService).createInstance(PinnedCanvasPageContribution));
	resources.add(registerPinnedCanvasSidebar(accessor.get(IPinnedCanvasService), accessor.get(INotificationService)));
	resources.add(EditorInputSerializers.register(accessor.get(IInstantiationService).createInstance(SessionCanvasSerializer)));
	resources.add(registerCanvasContextPicker(accessor));
	resources.add(registerSessionCanvasActions(canvases, accessor.get(ISessionCanvasRegistryService), accessor.get(ICanvasContextService)));
	return resources;
});

registerWorkbenchContribution('sessions.contrib.remoteCanvases', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(RemoteCanvasHostContribution));
