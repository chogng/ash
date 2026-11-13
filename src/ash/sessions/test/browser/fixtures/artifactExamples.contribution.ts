import { renderWorkbenchMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { URI } from '../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { getNLSLanguage } from '../../../../nls.js';
import { artifactKinds, isArtifactKind, type ArtifactKind } from '../../../common/artifactKind.js';
import { getArtifactTitle } from '../../../contrib/artifact/browser/artifactKindPresentation.js';
import { registerArtifactExamples } from '../../../contrib/artifact/browser/artifactExamples.js';
import { openArtifactWorkspace } from '../../../contrib/artifact/browser/artifactWorkspaceOpener.js';
import { getArtifactWorkspace } from '../../../contrib/artifact/browser/artifactWorkspaceRegistry.js';
import { mountArtifactWorkspace, type ArtifactDesignExample } from '../../../contrib/artifact/browser/artifactWorkspace.js';
import { openManagedCanvasArtifact } from '../../../contrib/artifact/browser/artifactCanvasWorkspaces.js';
import { IDesignEditorService } from '../../../contrib/artifact/browser/designEditorService.js';
import { ArtifactWorkspaceId } from '../../../contrib/artifact/common/artifactWorkspace.js';
import { DesignMode } from '../../../contrib/artifact/common/config/designEditorConfiguration.js';
import type { DesignShape } from '../../../contrib/artifact/common/model/designDocument.js';
import { ARTIFACT_EXAMPLE_SCHEME, createDocsOpener } from '../../../contrib/docs/browser/documentActions.js';
import { openTableArtifact } from '../../../contrib/sheets/browser/tableArtifactWorkspaces.js';
import { createSlides, frame, geometry, text } from './artifactExampleShapes.js';
import { exampleText } from './artifactExampleText.js';

const openExampleCommand = 'sessions.creator.openExample';

interface ArtifactExample {
	readonly detail: string;
	open(accessor: ServicesAccessor): Promise<void>;
}

const examples = new Map<ArtifactKind, (title: string) => ArtifactExample>();

function registerArtifactExample(kind: ArtifactKind, create: (title: string) => ArtifactExample): void {
	examples.set(kind, create);
}

function exampleTitle(kind: ArtifactKind): string {
	return exampleText('exampleTitle', '{0} example', getArtifactTitle(kind));
}

registerArtifactExample('docs', title => ({
	detail: exampleText('exampleDocs', 'A launch brief with headings, a checklist and a schedule'),
	open: accessor => openDocsExample(accessor, {
		title,
		text: exampleText('exampleDocsContent', '# Studio launch brief\n\nLaunch a shared home for the studio’s work. Start with a small pilot and use feedback to guide the public release.\n\n## Readiness checklist\n\n- [x] Review the visual direction\n- [ ] Invite the pilot group\n- [ ] Publish the launch notes\n\n## Schedule\n\n| Milestone | Target |\n| --- | --- |\n| Pilot | Tuesday |\n| Feedback review | Thursday |\n| Public launch | Next Monday |'),
	}),
}));

registerArtifactExample('slides', () => ({
	detail: exampleText('exampleSlides', 'A two-slide deck with presentation mode'),
	open: accessor => openManagedCanvasArtifact(accessor, accessor.get(IDesignEditorService).createArtifactDocument('slides', createSlides())),
}));

registerArtifactExample('design', title => ({
	detail: exampleText('exampleDesign', 'A landing page with editable layers'),
	open: accessor => openArtifactDesignExample(accessor, 'design', ArtifactWorkspaceId.Design, { title, createShapes: createDesign }),
}));

function createDesign(): readonly DesignShape[] {
	return [frame(0, 960, 560, '#f3efe7', exampleText('exampleLandingPage', 'Landing page'), [
		text(56, 38, 600, 'STUDIO / 01', 22, '#434434', 700),
		{ ...geometry(547, 88, 356, 394, '#dfecb5'), kind: 'rectangle' },
		{ ...geometry(600, 120, 243, 243, '#607747'), kind: 'ellipse' },
		{ ...geometry(693, 238, 173, 173, '#e89c6a'), kind: 'ellipse' },
		text(56, 153, 480, exampleText('exampleDesignHeadline', 'Room for\ngood work'), 66, '#252719', 700),
		text(56, 344, 465, exampleText('exampleDesignBody', 'A place to share ideas and make them real.'), 24, '#525546'),
		{ ...geometry(56, 416, 208, 52, '#30372a'), kind: 'rectangle' },
		text(78, 430, 168, exampleText('exampleExplore', 'Explore the studio'), 18, '#ffffff', 600),
	])];
}

registerArtifactExample('sheet', title => {
	const detail = exampleText('exampleSheet', 'A read-only launch budget grid');
	return {
		detail,
		open: accessor => openTableArtifact(accessor, {
			kind: 'sheet', title, detail,
			columns: [
				exampleText('exampleItem', 'Item'), exampleText('exampleOwner', 'Owner'),
				exampleText('exampleBudget', 'Budget'), exampleText('exampleSpent', 'Spent'),
			],
			rows: [
				[exampleText('exampleVisuals', 'Visuals'), 'Mina', 2400, 1800],
				[exampleText('exampleCopy', 'Copy'), 'Leo', 1200, 950],
				[exampleText('examplePilot', 'Pilot'), 'Sam', 800, 640],
			],
		}),
	};
});

registerArtifactExample('whiteboard', title => ({
	detail: exampleText('exampleWhiteboard', 'A planning board with notes and connectors'),
	open: accessor => openArtifactDesignExample(accessor, 'whiteboard', ArtifactWorkspaceId.Whiteboard, { title, createShapes: createWhiteboard }),
}));

function createWhiteboard(): readonly DesignShape[] {
	const stages = [
		[exampleText('examplePilot', 'Pilot'), exampleText('exampleInvite', 'Invite five teammates'), '#fff0a6'],
		[exampleText('exampleFeedback', 'Review feedback'), exampleText('exampleDiscuss', 'Discuss the pilot notes'), '#d8edc2'],
		[exampleText('exampleRelease', 'Publish launch notes'), exampleText('exampleShare', 'Share the release checklist'), '#d6e8fa'],
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
	return [frame(0, 860, 204, '#f8f8f3', exampleText('exampleSchedule', 'Launch schedule'), [...connectors, ...notes])];
}

registerArtifactExample('data', title => {
	const detail = exampleText('exampleData', 'A read-only overview of pilot activity');
	return {
		detail,
		open: accessor => {
			const rows = [[142, 21], [185, 28], [213, 38]] as const;
			const weekdays = new Intl.DateTimeFormat(getNLSLanguage(), { weekday: 'long', timeZone: 'UTC' });
			return openTableArtifact(accessor, {
				kind: 'data', title, detail,
				columns: [
					exampleText('exampleDay', 'Day'), exampleText('exampleVisits', 'Visits'),
					exampleText('exampleSignups', 'Sign-ups'),
				],
				rows: rows.map(([visits, signups], index) => [weekdays.format(Date.UTC(2026, 0, 5 + index)), visits, signups]),
				summary: [
					{ label: exampleText('exampleVisits', 'Visits'), value: rows.reduce((sum, row) => sum + row[0], 0) },
					{ label: exampleText('exampleSignups', 'Sign-ups'), value: rows.reduce((sum, row) => sum + row[1], 0) },
				],
			});
		},
	};
});

registerArtifactExample('motion', title => ({
	detail: exampleText('exampleMotion', 'A looping animation with editable keyframes'),
	open: accessor => openArtifactDesignExample(accessor, 'motion', ArtifactWorkspaceId.Design, { title, createShapes: createMotion, editorMode: DesignMode.Motion }),
}));

function createMotion(): readonly DesignShape[] {
	return [frame(0, 660, 360, '#191e33', exampleText('exampleLaunch', 'Studio launch'), [
		text(44, 32, 530, exampleText('exampleLaunch', 'Studio launch'), 34, '#ffffff', 600),
		{ ...geometry(44, 245, 560, 3, '#596484'), kind: 'rectangle' },
		{
			...geometry(60, 146, 94, 94, '#b8ec79'), kind: 'ellipse',
			name: exampleText('exampleAnimatedCircle', 'Animated circle'),
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

function openArtifactDesignExample(accessor: ServicesAccessor, kind: ArtifactKind, mode: ArtifactWorkspaceId, example: ArtifactDesignExample): Promise<void> {
	return openArtifactWorkspace(accessor, {
		key: `example:${kind}`, entryId: kind, title: example.title, help: getArtifactWorkspace(mode)?.help,
		mount: (instantiation, container) => mountArtifactWorkspace(instantiation, container, mode, example),
	});
}

async function openDocsExample(accessor: ServicesAccessor, example: { title: string; text: string; }): Promise<void> {
	const open = createDocsOpener(accessor);
	const ownerDocument = accessor.get(IEditorPart).domNode.ownerDocument;
	const { generalProfile, importGeneralDocumentHtml } = await import('../../../../../../extensions/academy/browser/generalProfile.js');
	const document = importGeneralDocumentHtml(renderWorkbenchMarkdown(example.text), ownerDocument);
	if (!document) throw new Error('The Docs example could not be opened.');
	await open(URI.from({ scheme: ARTIFACT_EXAMPLE_SCHEME, path: '/studio-launch.ash-doc' }), {
		label: example.title, initialText: generalProfile.create().codec.serialize(document),
	});
}

CommandsRegistry.register(openExampleCommand, (accessor, kind) => {
	if (!isArtifactKind(kind)) return;
	return examples.get(kind)?.(exampleTitle(kind)).open(accessor);
});

registerArtifactExamples({
	heading: exampleText('examples', 'Examples'),
	accessibilityHelp: exampleText('examplesHelp', 'In All, press Enter on the Slides example to create a deck. The deck saves automatically and can be reopened from Yours. Use Export editable copy to create a file package. Other canvas examples keep edits for this window. Docs, Sheet and Data examples are read-only.'),
	cards: artifactKinds.flatMap(kind => {
		const title = exampleTitle(kind);
		const example = examples.get(kind)?.(title);
		return example ? [{ kind, title, detail: example.detail, command: { id: openExampleCommand, args: [kind] } }] : [];
	}),
});
