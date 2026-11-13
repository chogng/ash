import { generateUuid } from '../../../../base/common/uuid.js';
import type { ArtifactCanvasShape, ArtifactCanvasShapeGeometry } from '../../../contrib/artifact/common/model/artifactCanvasDocument.js';
import { exampleText } from './artifactExampleText.js';

export function geometry(x: number, y: number, width: number, height: number, fill: string): ArtifactCanvasShapeGeometry {
	return { id: generateUuid(), x, y, width, height, fill, rotation: 0 };
}

export function text(x: number, y: number, width: number, value: string, fontSize: number, fill: string, fontWeight = 400): ArtifactCanvasShape {
	return { ...geometry(x, y, width, value.split('\n').length * fontSize * 1.3, fill), kind: 'text', text: value, fontSize, fontWeight };
}

export function frame(x: number, width: number, height: number, fill: string, name: string, children: readonly ArtifactCanvasShape[]): ArtifactCanvasShape {
	return { ...geometry(x, 0, width, height, fill), kind: 'frame', name, clip: true, children };
}

export function createSlides(): readonly ArtifactCanvasShape[] {
	const launch = exampleText('exampleLaunch', 'Studio launch');
	return [
		frame(0, 1280, 720, '#191e33', launch, [
			text(84, 94, 1050, exampleText('examplePilot', 'Pilot'), 32, '#b8ec79', 600),
			text(84, 242, 1110, launch, 112, '#ffffff', 700),
			text(84, 435, 990, exampleText('exampleSlidesTagline', 'A shared home for the studio’s work'), 42, '#cad0e6'),
			{ ...geometry(84, 602, 300, 10, '#b8ec79'), kind: 'rectangle' },
		]),
		frame(1320, 1280, 720, '#eff1f8', exampleText('exampleSchedule', 'Launch schedule'), [
			text(84, 86, 1100, exampleText('exampleSchedule', 'Launch schedule'), 70, '#191e33', 700),
			...[
				exampleText('examplePilot', 'Pilot'),
				exampleText('exampleFeedback', 'Review feedback'),
				exampleText('exampleRelease', 'Publish launch notes'),
			].map((step, index) => text(90, 244 + index * 112, 1010, `${index + 1}. ${step}`, 50, '#424f75', 600)),
		]),
	];
}
