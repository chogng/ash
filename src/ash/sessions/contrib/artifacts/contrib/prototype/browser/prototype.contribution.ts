import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../../../platform/contextkey/common/contextkey.js';
import { CanvasWorkspace } from '../../../browser/canvasWorkspace.js';
import { registerArtifactWorkspace } from '../../../browser/artifactWorkspaceRegistry.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../../common/artifactWorkspace.js';
import { DesignMode } from '../../../common/config/designEditorConfiguration.js';

const HasPrototypeScreens = new RawContextKey<boolean>('sessions.artifacts.prototype.hasScreens', false);

class PrototypeWorkspace extends CanvasWorkspace {
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

PrototypeWorkspace.registerToolbarActions();
registerArtifactWorkspace({
	id: ArtifactWorkspaceId.Prototype,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Prototype),
	description: localize('sessions.creator.prototype.description', 'Connect screens, define interactions and preview animated flows.'),
	icon: Lxicon.motion,
	help: localize('sessions.creator.prototype.help', 'Add screen creates a phone-sized screen. In Prototype properties, select a hotspot, add interactions and choose a trigger, action, destination and transition. Drag a connection handle to another screen, or choose Destination with the keyboard. Flow starting points name separate journeys. Preview flow follows those interactions. Tab focuses hotspots and Enter activates them. Back returns through navigation history; Escape closes the top overlay, then returns to editing. While hovering and While pressing restore the previous state when released. Edit animation opens the object timeline.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(PrototypeWorkspace, ownerDocument, ArtifactWorkspaceId.Prototype),
});
