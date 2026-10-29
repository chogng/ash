import {
	EditorContributionInstantiation,
	registerEditorContribution,
} from '../../../browser/editorFeatureRegistration.js';
import { MiddleScrollController } from './middleScrollController.js';

registerEditorContribution(
	MiddleScrollController.ID,
	MiddleScrollController,
	EditorContributionInstantiation.BeforeFirstInteraction,
);
