import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';

class DesignWorkspace extends CreatorCanvasWorkspace {
	protected override readonly hasWorkspaceActions = false;
}

registerCreatorMode({
	id: CreatorMode.Design,
	title: getCreatorModeTitle(CreatorMode.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize(
		'sessions.creator.design.help',
		'Design uses the canvas, Layers and Shape properties. The canvas context menu offers Add frame, Import image, Open design, Save a copy and Export SVG. Use the Artifacts navigation item to return home. Draw, Motion and Code are editing tools within this workspace.',
	),
	create: (instantiation, ownerDocument) => instantiation.createInstance(DesignWorkspace, ownerDocument, CreatorMode.Design),
});
