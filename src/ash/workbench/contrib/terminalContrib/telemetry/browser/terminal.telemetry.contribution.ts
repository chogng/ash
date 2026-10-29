import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { TerminalTelemetryContribution } from './terminalTelemetry.js';

registerWorkbenchContribution(TerminalTelemetryContribution.ID, WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(TerminalTelemetryContribution));
