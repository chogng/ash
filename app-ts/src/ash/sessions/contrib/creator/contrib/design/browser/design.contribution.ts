import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';

class DesignWorkspace extends CreatorCanvasWorkspace {
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('frame', localize('sessions.design.addFrame', 'Add frame (F)'), () => this.editor.addFrame()),
			this.action('image', localize('sessions.design.importImage', 'Import image'), () => this.editor.importImage()),
		];
	}
}

registerCreatorMode({
	id: CreatorMode.Design,
	title: getCreatorModeTitle(CreatorMode.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.creator.design.help', 'Design uses the canvas, Layers and Shape properties. Add a frame or import an image. Draw, Motion and Code are editing tools within this workspace.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(DesignWorkspace, ownerDocument, CreatorMode.Design),
});
