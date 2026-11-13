import { registerArtifactCanvasMotionContribution } from '../../artifact/browser/artifactCanvasEditorContributions.js';
import { DesignMotionWidget } from './designMotionWidget.js';

registerArtifactCanvasMotionContribution(({ ownerDocument, documentController, commands }) =>
	new DesignMotionWidget(ownerDocument, documentController.model, commands));
