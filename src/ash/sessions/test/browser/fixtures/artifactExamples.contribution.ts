import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { registerWorkbenchServiceContribution } from '../../../../workbench/browser/workbenchServiceContributions.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IUserDataProfileService } from '../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { createArkdownDocsInput } from '../../../contrib/docs/browser/docsEditorInput.js';
import { artifactCanvasModes } from '../../../contrib/artifact/common/artifactWorkspace.js';
import { getArtifactDraftHome } from '../../../contrib/artifact/browser/artifactStorage.js';
import { documentFromShapes, serializeArtifactCanvasDocument, type ArtifactCanvasShape } from '../../../contrib/artifact/common/model/artifactCanvasDocument.js';
import { createSlides, frame, geometry, text } from './artifactExampleShapes.js';
import { getArtifactTitle } from '../../../contrib/artifact/browser/artifactKindPresentation.js';
import { exampleText } from './artifactExampleText.js';

/** Development hosts already use an isolated profile; test hosts supply their own file provider. */
registerWorkbenchServiceContribution({
	service: createServiceIdentifier<Promise<void>>('test.artifactFixtures'),
	dependencies: [IFileService, IUserDataProfileService, IWorkspaceContextService, IEditorPart],
	install: ({ container, blockRestorationUntil }) => {
		const editors = container.get(IEditorPart);
		const ready = prepareArtifactFixtures(container.get(IFileService), container.get(IUserDataProfileService).currentProfile.location,
			container.get(IWorkspaceContextService).getWorkspace().id).then(async resource => {
			// Retained Docs use the ordinary editor catalog. Open the file before the host restores its selected page.
			if (!editors.groups.some(group => group.editors.some(editor => editor.input.resource.toString() === resource.toString()))) {
				await editors.openEditor(createArkdownDocsInput({ resource }), { pinned: true, inactive: true, preserveFocus: true });
			}
		});
		blockRestorationUntil(ready);
		return ready;
	},
});

/** Seed once, including a completion marker so deleted fixtures stay deleted and edits survive reload. */
export async function prepareArtifactFixtures(files: IFileService, profile: URI, workspaceId: string): Promise<URI> {
	const home = getArtifactDraftHome(profile, workspaceId);
	const marker = home.joinPathSegment('test-data-v2');
	const docs = home.joinPathSegment('studio-launch.md');
	try { await files.stat(marker); return docs; } catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
	await files.createDirectory(home);
	for (const [kind, shapes] of [['slides', createSlides()], ['design', createDesign()], ['whiteboard', createWhiteboard()], ['motion', createMotion()]] as const) {
		const id = fixtureCanvasIds[kind];
		const resource = home.joinPathSegment(kind).joinPathSegment(`${id}.ash-design`);
		await files.createDirectory(resource);
		await writeMissing(files, resource.joinPathSegment('manifest.json'), serializeArtifactCanvasDocument(documentFromShapes(shapes, {
			documentId: id, artifactId: generateUuid(), mode: artifactCanvasModes[kind], title: shapes[0].name, createdAt: Date.now(),
		})));
	}
	const tables = home.joinPathSegment('tables');
	await files.createDirectory(tables);
	for (const [kind, rows] of [
		['sheet', [[exampleText('exampleItem', 'Item'), exampleText('exampleOwner', 'Owner'), exampleText('exampleBudget', 'Budget'), exampleText('exampleSpent', 'Spent')],
			[exampleText('exampleVisuals', 'Visuals'), 'Mina', '2400', '1800'], [exampleText('exampleCopy', 'Copy'), 'Leo', '1200', '950'], [exampleText('examplePilot', 'Pilot'), 'Sam', '800', '640']]],
		['data', [[exampleText('exampleDay', 'Day'), exampleText('exampleVisits', 'Visits'), exampleText('exampleSignups', 'Sign-ups')], ['2026-01-05', '142', '21'], ['2026-01-06', '185', '28'], ['2026-01-07', '213', '38']]],
	] as const) {
		await writeMissing(files, tables.joinPathSegment(`${fixtureTableIds[kind]}.json`), JSON.stringify({ kind, rows, createdAt: Date.now(), title: exampleText('exampleTitle', '{0} example', getArtifactTitle(kind)) }));
	}
	let markdown = exampleText('exampleDocsContent', '# Studio launch brief\n\nLaunch a shared home for the studio’s work. Start with a small pilot and use feedback to guide the public release.\n\n## Readiness checklist\n\n- [x] Review the visual direction\n- [ ] Invite the pilot group\n- [ ] Publish the launch notes\n\n## Schedule\n\n| Milestone | Target |\n| --- | --- |\n| Pilot | Tuesday |\n| Feedback review | Thursday |\n| Public launch | Next Monday |');
	try {
		const legacy = await files.readFile(home.joinPathSegment('studio-launch.ash-doc'));
		const { legacyDocsToMarkdown } = await import('../../../contrib/docs/browser/docsImport.js');
		markdown = legacyDocsToMarkdown(legacy.content);
	} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
	await writeMissing(files, docs, markdown);
	await files.writeFile({ resource: marker, content: '1' });
	return docs;
}

async function writeMissing(files: IFileService, resource: URI, content: string): Promise<void> {
	try { await files.stat(resource); return; } catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
	await files.writeFile({ resource, content });
}

const fixtureCanvasIds = {
	slides: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc01', design: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc02',
	whiteboard: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc03', motion: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc04',
};
const fixtureTableIds = { sheet: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc05', data: 'b0b272fa-4d83-4ae6-b20d-438e8b2ebc06' };

function createDesign(): readonly ArtifactCanvasShape[] {
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

function createWhiteboard(): readonly ArtifactCanvasShape[] {
	const stages = [
		[exampleText('examplePilot', 'Pilot'), exampleText('exampleInvite', 'Invite five teammates'), '#fff0a6'],
		[exampleText('exampleFeedback', 'Review feedback'), exampleText('exampleDiscuss', 'Discuss the pilot notes'), '#d8edc2'],
		[exampleText('exampleRelease', 'Publish launch notes'), exampleText('exampleShare', 'Share the release checklist'), '#d6e8fa'],
	];
	const notes = stages.map(([name, body, fill], index) => frame(35 + index * 280, 220, 172, fill, name, [
		text(16, 22, 189, name, 22, '#33342b', 700),
		text(16, 90, 189, body, 18, '#33342b'),
	]));
	const connectors = [0, 1].map((index): ArtifactCanvasShape => {
		const a = { x: 0, y: 0 }, b = { x: 1, y: 0 };
		return {
			...geometry(255 + index * 280, 86, 60, 1, '#687461'), kind: 'path', closed: false, strokeWidth: 2,
			nodes: [{ ...a, incoming: a, outgoing: a }, { ...b, incoming: b, outgoing: b, endpoint: 'triangle-arrow' }],
		};
	});
	return [frame(0, 860, 204, '#f8f8f3', exampleText('exampleSchedule', 'Launch schedule'), [...connectors, ...notes])];
}

function createMotion(): readonly ArtifactCanvasShape[] {
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
