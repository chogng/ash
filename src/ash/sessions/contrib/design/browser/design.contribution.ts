import { DesignWorkspace } from './designWorkspace.js';
import { registerArtifactCanvasDocument } from '../../artifact/browser/artifactCanvasCatalog.js';
import { registerArtifactCanvasCodeContribution } from '../../artifact/browser/artifactCanvasEditorContributions.js';
import { DesignCodeWidget } from './code/designCodeWidget.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { openArtifacts } from '../../artifact/browser/artifactWorkspaceOpener.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';

registerArtifactCanvasCodeContribution((context, exportCode) => new DesignCodeWidget(context.ownerDocument, context.documentController, exportCode));

DesignWorkspace.registerToolbarActions();

registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Design,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Design),
	description: localize('sessions.artifacts.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.artifacts.design.help', 'Design uses the canvas, Layers and Shape properties. The canvas context menu offers Add frame, Import image, Open design, Save a copy and Export SVG. Use the Artifacts navigation item to return home. Draw, Motion and Code are editing tools within this workspace.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(DesignWorkspace, ownerDocument, ArtifactWorkspaceId.Design));

CommandsRegistry.register('sessions.restore.artifactsDesign', (accessor, source) => openArtifacts(accessor, page => page.openMode(ArtifactWorkspaceId.Design), { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.artifacts' }));

registerArtifactCanvasDocument('design', document => document.saveStatus);
