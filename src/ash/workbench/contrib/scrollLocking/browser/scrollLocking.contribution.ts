import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { SyncScroll } from './scrollLocking.js';

registerWorkbenchContribution(SyncScroll.ID, WorkbenchPhase.Eventually, accessor => accessor.get(IInstantiationService).createInstance(SyncScroll));
