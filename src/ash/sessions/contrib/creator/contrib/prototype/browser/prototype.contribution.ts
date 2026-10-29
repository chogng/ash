import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';
import { DesignMode } from '../../../common/config/editorConfiguration.js';

class PrototypeWorkspace extends CreatorCanvasWorkspace {
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('screen', localize('sessions.creator.prototype.addScreen', 'Add screen'), () => this.addFrame(390, 844)),
			this.action(
				'preview',
				localize('sessions.creator.prototype.preview', 'Preview flow'),
				() => this.editor.previewPrototype(),
				this.document.model.value.shapes.some(shape => shape.kind === 'frame' && !shape.component),
			),
			this.action('motion', localize('sessions.creator.prototype.motion', 'Edit animation'), () => this.editor.setMode(DesignMode.Motion)),
		];
	}
}

registerCreatorMode({
	id: CreatorMode.Prototype,
	title: getCreatorModeTitle(CreatorMode.Prototype),
	description: localize('sessions.creator.prototype.description', 'Connect screens, define interactions and preview animated flows.'),
	icon: Lxicon.motion,
	help: localize(
		'sessions.creator.prototype.help',
		'Add screen creates a phone-sized screen. In Prototype properties, select a hotspot, add interactions and choose a trigger, action, destination and transition. Drag a connection handle to another screen, or choose Destination with the keyboard. Flow starting points name separate journeys. Preview flow follows those interactions. Tab focuses hotspots and Enter activates them. Back returns through navigation history; Escape closes the top overlay, then returns to editing. While hovering and While pressing restore the previous state when released. Edit animation opens the object timeline.',
	),
	create: (instantiation, ownerDocument) => instantiation.createInstance(PrototypeWorkspace, ownerDocument, CreatorMode.Prototype),
});
