import { EditorContributionInstantiation, registerEditorContribution } from '../../../registration.js';
import { MiddleScrollController } from './middleScrollController.js';

registerEditorContribution(MiddleScrollController.ID, MiddleScrollController, EditorContributionInstantiation.BeforeFirstInteraction);
