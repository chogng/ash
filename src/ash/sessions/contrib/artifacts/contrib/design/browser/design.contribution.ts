import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CanvasWorkspace } from '../../../browser/canvasWorkspace.js';
import { registerArtifactWorkspace } from '../../../browser/artifactWorkspaceRegistry.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../../common/artifactWorkspace.js';

registerArtifactWorkspace({
	id: ArtifactWorkspaceId.Design,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.creator.design.help', 'Design uses the canvas, Layers and Shape properties. The canvas context menu offers Add frame, Import image, Open design, Save a copy and Export SVG. Use the Artifacts navigation item to return home. Draw, Motion and Code are editing tools within this workspace.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(CanvasWorkspace, ownerDocument, ArtifactWorkspaceId.Design),
});
