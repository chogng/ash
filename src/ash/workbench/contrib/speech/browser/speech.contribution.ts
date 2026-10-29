import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ISpeechService } from '../common/speechService.js';
import { SpeechAccessibilitySignalContribution } from './speechAccessibilitySignal.js';
import { SpeechService } from './speechService.js';

registerSingleton(ISpeechService, SpeechService, InstantiationType.Delayed);
registerWorkbenchContribution(SpeechAccessibilitySignalContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(SpeechAccessibilitySignalContribution),
);
