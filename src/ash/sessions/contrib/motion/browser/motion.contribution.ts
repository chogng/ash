import { registerDesignMotionContribution } from '../../artifact/browser/designEditorContributions.js';
import { DesignMotionWidget } from './designMotionWidget.js';
import { registerArtifactExample } from '../../artifact/browser/artifactExamples.js';
import { frame, geometry, text } from '../../artifact/browser/artifactExampleShapes.js';
import { openArtifactDesignExample } from '../../artifact/browser/artifactDesignWorkspaces.js';
import type { DesignShape } from '../../artifact/common/model/designDocument.js';
import { localize } from '../../../../nls.js';
import { DesignMode } from '../../artifact/common/config/designEditorConfiguration.js';
import { ArtifactWorkspaceId } from '../../artifact/common/artifactWorkspace.js';

registerDesignMotionContribution(({ ownerDocument, documentController, commands }) =>
	new DesignMotionWidget(ownerDocument, documentController.model, commands));

registerArtifactExample('motion', title => ({
	detail: localize('sessions.artifacts.exampleMotion', 'A looping animation with editable keyframes'),
	open: accessor => openArtifactDesignExample(accessor, 'motion', ArtifactWorkspaceId.Design, { title, createShapes: createMotion, editorMode: DesignMode.Motion }),
}));

function createMotion(): readonly DesignShape[] {
	return [frame(0, 660, 360, '#191e33', localize('sessions.artifacts.exampleLaunch', 'Studio launch'), [
		text(44, 32, 530, localize('sessions.artifacts.exampleLaunch', 'Studio launch'), 34, '#ffffff', 600),
		{ ...geometry(44, 245, 560, 3, '#596484'), kind: 'rectangle' },
		{
			...geometry(60, 146, 94, 94, '#b8ec79'), kind: 'ellipse',
			name: localize('sessions.artifacts.exampleAnimatedCircle', 'Animated circle'),
			motion: {
				duration: 2400, loop: true, keyframes: [
					{ offset: 0, x: 60, y: 146, rotation: 0, opacity: 1 },
					{ offset: 0.5, x: 495, y: 88, rotation: 0, opacity: 0.65 },
					{ offset: 1, x: 60, y: 146, rotation: 0, opacity: 1 },
				]
			},
		},
	])];
}
