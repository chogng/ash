import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { DropIntoEditorController } from './dropIntoEditorController.js';

registerEditorContribution(
	DropIntoEditorController.ID,
	DropIntoEditorController,
	EditorContributionInstantiation.BeforeFirstInteraction,
);

export type PreferredDropConfiguration = string;
