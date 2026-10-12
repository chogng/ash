import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { TerminalNativeContribution } from './terminalNativeContribution.js';

registerWorkbenchContribution(TerminalNativeContribution.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(TerminalNativeContribution));
