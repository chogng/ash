import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { CopyPasteController } from './copyPasteController.js';

registerEditorContribution(
	CopyPasteController.ID,
	CopyPasteController,
	EditorContributionInstantiation.Eager,
);
