import { registerDesignCanvasView } from '../../artifact/browser/designEditorContributions.js';
import { DesignCanvasView } from './designCanvasView.js';
import { registerArtifactCanvasDocument } from '../../artifact/browser/artifactCanvasCatalog.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { openArtifacts } from '../../artifact/browser/artifactWorkspaceOpener.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';

registerDesignCanvasView((ownerDocument, instantiation) => instantiation.createInstance(DesignCanvasView, ownerDocument));

registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Design,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.creator.design.help', 'Design uses the canvas, Layers and Shape properties. The canvas context menu offers Add frame, Import image, Open design, Save a copy and Export SVG. Use the Artifacts navigation item to return home. Draw, Motion and Code are editing tools within this workspace.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(ArtifactWorkspace, ownerDocument, ArtifactWorkspaceId.Design));

CommandsRegistry.register('sessions.restore.creatorDesign', (accessor, source) => openArtifacts(accessor, page => page.openMode(ArtifactWorkspaceId.Design), { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));

registerArtifactCanvasDocument('design', document => document.saveStatus);
