import { registerDesignMotionContribution } from '../../artifact/browser/designEditorContributions.js';
import { DesignMotionWidget } from './designMotionWidget.js';

registerDesignMotionContribution(({ ownerDocument, documentController, commands }) =>
	new DesignMotionWidget(ownerDocument, documentController.model, commands));
