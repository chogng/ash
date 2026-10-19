import './placeholderText.css';
import { EditorContributionInstantiation, type EditorContributionRegistration } from '../../registration.js';
import { PlaceholderTextContribution } from './placeholderTextContribution.js';
import { wrapInReloadableClass1 } from '../../../../../src/ash/platform/observable/common/wrapInReloadableClass.js';

export const placeholderContribution: EditorContributionRegistration = Object.freeze({
	id: PlaceholderTextContribution.ID,
	ctor: wrapInReloadableClass1(() => PlaceholderTextContribution),
	instantiation: EditorContributionInstantiation.Eager,
});
