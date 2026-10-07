import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { CreatorFrameNavigator } from '../../../browser/creatorFrameNavigator.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';
import { DesignMode } from '../../../common/config/editorConfiguration.js';

class PrototypeWorkspace extends CreatorCanvasWorkspace {
	private screens!: CreatorFrameNavigator;
	protected override createModeContent(): void {
		this.screens = this._register(new CreatorFrameNavigator(this.actionsDomNode, this.contentDomNode, this.document, id => this.editor.revealShape(id)));
	}
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('screen', localize('sessions.creator.prototype.addScreen', 'Add screen'), () => this.screens.select(this.addFrame(390, 844))),
			this.action('preview', localize('sessions.creator.prototype.preview', 'Preview flow'), () => this.screens.showPreview(true), this.screens.frames.length > 0),
			this.action('motion', localize('sessions.creator.prototype.motion', 'Edit animation'), () => this.editor.setMode(DesignMode.Motion)),
		];
	}
	public override focus(): void { if (this.screens.isPresenting) { this.screens.focus(); } else { super.focus(); } }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.screens.setVisible(visible); }
}

registerCreatorMode({
	id: CreatorMode.Prototype,
	title: getCreatorModeTitle(CreatorMode.Prototype),
	description: localize('sessions.creator.prototype.description', 'Design screens and walk through their sequence.'),
	icon: Lxicon.motion,
	help: localize('sessions.creator.prototype.help', 'Add screen creates a phone-sized screen. Preview flow walks through screens in document order with Previous page and Next page. Escape returns to editing. Edit animation opens the object timeline. Click targets and branching flows are not available.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(PrototypeWorkspace, ownerDocument, CreatorMode.Prototype),
});
