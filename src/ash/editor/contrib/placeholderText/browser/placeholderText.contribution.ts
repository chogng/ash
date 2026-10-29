import './placeholderText.css';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorFeatureRegistration.js';
import { PlaceholderTextContribution } from './placeholderTextContribution.js';
import { wrapInReloadableClass1 } from '../../../../platform/observable/common/wrapInReloadableClass.js';

registerEditorContribution(
	PlaceholderTextContribution.ID,
	wrapInReloadableClass1(() => PlaceholderTextContribution),
	EditorContributionInstantiation.Eager,
);
