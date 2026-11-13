import { registerArtifactDesignDocument } from '../../artifact/browser/artifactDesignCatalog.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { openArtifacts } from '../../artifact/browser/artifactWorkspaceOpener.js';
import { registerArtifactExample } from '../../artifact/browser/artifactExamples.js';
import { frame, geometry, text } from '../../artifact/browser/artifactExampleShapes.js';
import { openArtifactDesignExample } from '../../artifact/browser/artifactDesignWorkspaces.js';
import type { DesignShape } from '../../artifact/common/model/designDocument.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';

registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Design,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.creator.design.help', 'Design uses the canvas, Layers and Shape properties. The canvas context menu offers Add frame, Import image, Open design, Save a copy and Export SVG. Use the Artifacts navigation item to return home. Draw, Motion and Code are editing tools within this workspace.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(ArtifactWorkspace, ownerDocument, ArtifactWorkspaceId.Design));

CommandsRegistry.register('sessions.restore.creatorDesign', (accessor, source) => openArtifacts(accessor, page => page.openMode(ArtifactWorkspaceId.Design), { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));

registerArtifactDesignDocument('design', document => document.saveStatus);

registerArtifactExample('design', title => ({
	detail: localize('sessions.artifacts.exampleDesign', 'A landing page with editable layers'),
	open: accessor => openArtifactDesignExample(accessor, 'design', ArtifactWorkspaceId.Design, { title, createShapes: createDesign }),
}));

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
