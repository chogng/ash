import { generateUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { artifactKinds, type ArtifactKind } from '../../../common/artifactKind.js';
import { ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { DesignMode } from '../common/config/designEditorConfiguration.js';
import type { DesignShape, DesignShapeGeometry } from '../common/model/designDocument.js';
import { getArtifactTitle } from './artifactKindPresentation.js';

export const OPEN_ARTIFACT_EXAMPLE = 'sessions.creator.openExample';
export const ARTIFACT_EXAMPLE_SCHEME = 'ash-artifact-example';

interface ExampleCard {
	readonly kind: ArtifactKind;
	readonly title: string;
	readonly detail: string;
}

export interface CanvasArtifactExample extends ExampleCard {
	readonly type: 'canvas';
	readonly mode: ArtifactWorkspaceId;
	readonly editorMode?: DesignMode;
	createShapes(): readonly DesignShape[];
}

export interface TableArtifactExample extends ExampleCard {
	readonly type: 'table';
	readonly columns: readonly string[];
	readonly rows: readonly (readonly (string | number)[])[];
	readonly summary?: readonly { readonly label: string; readonly value: number; }[];
}

interface DocsArtifactExample extends ExampleCard {
	readonly type: 'docs';
	readonly text: string;
}

export type ArtifactExample = CanvasArtifactExample | TableArtifactExample | DocsArtifactExample;

export function getArtifactExamples(): readonly ArtifactExample[] {
	return artifactKinds.map(getArtifactExample);
}

export function getArtifactExample(kind: ArtifactKind): ArtifactExample {
	const title = localize('sessions.artifacts.exampleTitle', '{0} example', getArtifactTitle(kind));
	switch (kind) {
		case 'docs': return {
			kind, title, type: 'docs', detail: localize('sessions.artifacts.exampleDocs', 'A launch brief with headings, a checklist and a schedule'),
			text: localize('sessions.artifacts.exampleDocsContent', '# Studio launch brief\n\nLaunch a shared home for the studio’s work. Start with a small pilot and use feedback to guide the public release.\n\n## Readiness checklist\n\n- [x] Review the visual direction\n- [ ] Invite the pilot group\n- [ ] Publish the launch notes\n\n## Schedule\n\n| Milestone | Target |\n| --- | --- |\n| Pilot | Tuesday |\n| Feedback review | Thursday |\n| Public launch | Next Monday |'),
		};
		case 'slides': return {
			kind, title, type: 'canvas', mode: ArtifactWorkspaceId.Slides,
			detail: localize('sessions.artifacts.exampleSlides', 'A two-slide deck with presentation mode'), createShapes: createSlides,
		};
		case 'design': return {
			kind, title, type: 'canvas', mode: ArtifactWorkspaceId.Design,
			detail: localize('sessions.artifacts.exampleDesign', 'A landing page with editable layers'), createShapes: createDesign,
		};
		case 'sheet': return {
			kind, title, type: 'table', detail: localize('sessions.artifacts.exampleSheet', 'A read-only launch budget grid'),
			columns: [
				localize('sessions.artifacts.exampleItem', 'Item'), localize('sessions.artifacts.exampleOwner', 'Owner'),
				localize('sessions.artifacts.exampleBudget', 'Budget'), localize('sessions.artifacts.exampleSpent', 'Spent'),
			],
			rows: [
				[localize('sessions.artifacts.exampleVisuals', 'Visuals'), 'Mina', 2400, 1800],
				[localize('sessions.artifacts.exampleCopy', 'Copy'), 'Leo', 1200, 950],
				[localize('sessions.artifacts.examplePilot', 'Pilot'), 'Sam', 800, 640],
			],
		};
		case 'whiteboard': return {
			kind, title, type: 'canvas', mode: ArtifactWorkspaceId.Whiteboard,
			detail: localize('sessions.artifacts.exampleWhiteboard', 'A planning board with notes and connectors'), createShapes: createWhiteboard,
		};
		case 'data': {
			const rows = [[142, 21], [185, 28], [213, 38]] as const;
			const weekdays = new Intl.DateTimeFormat(getNLSLanguage(), { weekday: 'long', timeZone: 'UTC' });
			return {
				kind, title, type: 'table', detail: localize('sessions.artifacts.exampleData', 'A read-only overview of pilot activity'),
				columns: [
					localize('sessions.artifacts.exampleDay', 'Day'), localize('sessions.artifacts.exampleVisits', 'Visits'),
					localize('sessions.artifacts.exampleSignups', 'Sign-ups'),
				],
				rows: rows.map(([visits, signups], index) => [weekdays.format(Date.UTC(2026, 0, 5 + index)), visits, signups]),
				summary: [
					{ label: localize('sessions.artifacts.exampleVisits', 'Visits'), value: rows.reduce((sum, row) => sum + row[0], 0) },
					{ label: localize('sessions.artifacts.exampleSignups', 'Sign-ups'), value: rows.reduce((sum, row) => sum + row[1], 0) },
				],
			};
		}
		case 'motion': return {
			kind, title, type: 'canvas', mode: ArtifactWorkspaceId.Design, editorMode: DesignMode.Motion,
			detail: localize('sessions.artifacts.exampleMotion', 'A looping animation with editable keyframes'), createShapes: createMotion,
		};
	}
}

function geometry(x: number, y: number, width: number, height: number, fill: string): DesignShapeGeometry {
	return { id: generateUuid(), x, y, width, height, fill, rotation: 0 };
}

function text(x: number, y: number, width: number, value: string, fontSize: number, fill: string, fontWeight = 400): DesignShape {
	return { ...geometry(x, y, width, value.split('\n').length * fontSize * 1.3, fill), kind: 'text', text: value, fontSize, fontWeight };
}

function frame(x: number, width: number, height: number, fill: string, name: string, children: readonly DesignShape[]): DesignShape {
	return { ...geometry(x, 0, width, height, fill), kind: 'frame', name, clip: true, children };
}

function createSlides(): readonly DesignShape[] {
	const launch = localize('sessions.artifacts.exampleLaunch', 'Studio launch');
	return [
		frame(0, 1280, 720, '#191e33', launch, [
			text(84, 94, 1050, localize('sessions.artifacts.examplePilot', 'Pilot'), 32, '#b8ec79', 600),
			text(84, 242, 1110, launch, 112, '#ffffff', 700),
			text(84, 435, 990, localize('sessions.artifacts.exampleSlidesTagline', 'A shared home for the studio’s work'), 42, '#cad0e6'),
			{ ...geometry(84, 602, 300, 10, '#b8ec79'), kind: 'rectangle' },
		]),
		frame(1320, 1280, 720, '#eff1f8', localize('sessions.artifacts.exampleSchedule', 'Launch schedule'), [
			text(84, 86, 1100, localize('sessions.artifacts.exampleSchedule', 'Launch schedule'), 70, '#191e33', 700),
			...[
				localize('sessions.artifacts.examplePilot', 'Pilot'),
				localize('sessions.artifacts.exampleFeedback', 'Review feedback'),
				localize('sessions.artifacts.exampleRelease', 'Publish launch notes'),
			].map((step, index) => text(90, 244 + index * 112, 1010, `${index + 1}. ${step}`, 50, '#424f75', 600)),
		]),
	];
}

function createDesign(): readonly DesignShape[] {
	return [frame(0, 960, 560, '#f3efe7', localize('sessions.artifacts.exampleLandingPage', 'Landing page'), [
		text(56, 38, 600, 'STUDIO / 01', 22, '#434434', 700),
		{ ...geometry(547, 88, 356, 394, '#dfecb5'), kind: 'rectangle' },
		{ ...geometry(600, 120, 243, 243, '#607747'), kind: 'ellipse' },
		{ ...geometry(693, 238, 173, 173, '#e89c6a'), kind: 'ellipse' },
		text(56, 153, 480, localize('sessions.artifacts.exampleDesignHeadline', 'Room for\ngood work'), 66, '#252719', 700),
		text(56, 344, 465, localize('sessions.artifacts.exampleDesignBody', 'A place to share ideas and make them real.'), 24, '#525546'),
		{ ...geometry(56, 416, 208, 52, '#30372a'), kind: 'rectangle' },
		text(78, 430, 168, localize('sessions.artifacts.exampleExplore', 'Explore the studio'), 18, '#ffffff', 600),
	])];
}

function createWhiteboard(): readonly DesignShape[] {
	const stages = [
		[localize('sessions.artifacts.examplePilot', 'Pilot'), localize('sessions.artifacts.exampleInvite', 'Invite five teammates'), '#fff0a6'],
		[localize('sessions.artifacts.exampleFeedback', 'Review feedback'), localize('sessions.artifacts.exampleDiscuss', 'Discuss the pilot notes'), '#d8edc2'],
		[localize('sessions.artifacts.exampleRelease', 'Publish launch notes'), localize('sessions.artifacts.exampleShare', 'Share the release checklist'), '#d6e8fa'],
	];
	const notes = stages.map(([name, body, fill], index) => frame(35 + index * 280, 220, 172, fill, name, [
		text(16, 22, 189, name, 22, '#33342b', 700),
		text(16, 90, 189, body, 18, '#33342b'),
	]));
	const connectors = [0, 1].map((index): DesignShape => {
		const a = { x: 0, y: 0 }, b = { x: 1, y: 0 };
		return {
			...geometry(255 + index * 280, 86, 60, 1, '#687461'), kind: 'path', closed: false, strokeWidth: 2,
			nodes: [{ ...a, incoming: a, outgoing: a }, { ...b, incoming: b, outgoing: b, endpoint: 'triangle-arrow' }],
		};
	});
	return [frame(0, 860, 204, '#f8f8f3', localize('sessions.artifacts.exampleSchedule', 'Launch schedule'), [...connectors, ...notes])];
}

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
