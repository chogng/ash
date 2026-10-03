import './chatEditingEditorActions.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatEditingService } from '../../common/editing/chatEditingService.js';
import { ChatEditingService } from './chatEditingServiceImpl.js';
import { ChatEditingEditorOverlay } from './chatEditingEditorOverlay.js';

registerSingleton(IChatEditingService, ChatEditingService, InstantiationType.Delayed);
registerWorkbenchContribution(ChatEditingEditorOverlay.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(ChatEditingEditorOverlay));
