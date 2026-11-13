import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { registerDesignPrototypeContribution } from '../../artifact/browser/designEditorContributions.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';
import { DesignMode } from '../../artifact/common/config/designEditorConfiguration.js';
import { DesignPrototypeWidget } from './designPrototypeWidget.js';

const HasPrototypeScreens = new RawContextKey<boolean>('sessions.artifacts.prototype.hasScreens', false);

class PrototypeWorkspace extends ArtifactWorkspace {
	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Prototype, [
			{ id: 'screen', title: localize2('sessions.creator.prototype.addScreen', 'Add screen'), run: workspace => workspace.addFrame(390, 844) },
			{ id: 'preview', title: localize2('sessions.creator.prototype.preview', 'Preview flow'), precondition: HasPrototypeScreens.isEqualTo(true), run: workspace => workspace.editor.previewPrototype() },
			{ id: 'motion', title: localize2('sessions.creator.prototype.motion', 'Edit animation'), run: workspace => workspace.editor.setMode(DesignMode.Motion) },
		]);
	}

	protected override bindToolbarContext(contextKeys: IContextKeyService): () => void {
		const hasScreens = HasPrototypeScreens.bindTo(contextKeys);
		return () => hasScreens.set(this.document.model.value.shapes.some(shape => shape.kind === 'frame' && !shape.component));
	}
}

registerDesignPrototypeContribution((context, instantiation) => instantiation.createInstance(DesignPrototypeWidget, context));
PrototypeWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Prototype,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Prototype),
	description: localize('sessions.creator.prototype.description', 'Connect screens, define interactions and preview animated flows.'),
	icon: Lxicon.motion,
	help: localize('sessions.creator.prototype.help', 'Add screen creates a phone-sized screen. In Prototype properties, select a hotspot, add interactions and choose a trigger, action, destination and transition. Drag a connection handle to another screen, or choose Destination with the keyboard. Flow starting points name separate journeys. Preview flow follows those interactions. Tab focuses hotspots and Enter activates them. Back returns through navigation history; Escape closes the top overlay, then returns to editing. While hovering and While pressing restore the previous state when released. Edit animation opens the object timeline.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(PrototypeWorkspace, ownerDocument, ArtifactWorkspaceId.Prototype));
