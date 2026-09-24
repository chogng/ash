import './placeholderText.css';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { PlaceholderTextContribution } from './placeholderTextContribution.js';

registerEditorContribution(PlaceholderTextContribution.ID, PlaceholderTextContribution, EditorContributionInstantiation.Eager);
