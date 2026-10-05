import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { CreatorModes } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';
import type { DesignShape } from '../../../common/model/document.js';

class BrandWorkspace extends CreatorCanvasWorkspace {
	private createVariants(): void {
		const frame = this.document.model.value.shapes.find(shape => shape.kind === 'frame' && this.editor.selection.ids.has(shape.id));
		if (frame?.kind !== 'frame') { return; }
		const clone = (shape: DesignShape): DesignShape => {
			const copy = { ...shape, id: generateUuid() };
			return copy.kind === 'frame' || copy.kind === 'group' ? { ...copy, children: copy.children.map(clone) } : copy;
		};
		const right = Math.max(...this.document.model.value.shapes.map(shape => shape.x + shape.width));
		const variants = [[1080, 1080], [1080, 1920], [1200, 628]].map(([width, height], index): DesignShape => ({
			...frame, id: generateUuid(), x: right + 40 + index * 1240, y: frame.y, width, height,
			children: frame.children.length === 0 ? [] : [{ id: generateUuid(), kind: 'group', x: 0, y: 0, width: Math.min(width / frame.width, height / frame.height) * frame.width, height: Math.min(width / frame.width, height / frame.height) * frame.height, rotation: 0, fill: frame.fill, contentWidth: frame.width, contentHeight: frame.height, children: frame.children.map(clone) }],
		}));
		this.document.model.applyEdit([...this.document.model.value.shapes, ...variants]);
		this.editor.revealShape(variants[0].id);
	}
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('square', localize('sessions.creator.brand.square', 'Square asset'), () => this.addFrame(1080, 1080)),
			this.action('portrait', localize('sessions.creator.brand.portrait', 'Portrait asset'), () => this.addFrame(1080, 1920)),
			this.action('landscape', localize('sessions.creator.brand.landscape', 'Landscape asset'), () => this.addFrame(1200, 628)),
			this.action('variants', localize('sessions.creator.brand.variants', 'Create size variants'), () => this.createVariants(), this.document.model.value.shapes.some(shape => shape.kind === 'frame' && this.editor.selection.ids.has(shape.id))),
		];
	}
}

CreatorModes.set(CreatorMode.Brand, {
	id: CreatorMode.Brand,
	title: getCreatorModeTitle(CreatorMode.Brand),
	description: localize('sessions.creator.brand.description', 'Create campaign artwork and generate size variants.'),
	icon: Lxicon.symbolColor,
	help: localize('sessions.creator.brand.help', 'Choose Square asset, Portrait asset or Landscape asset to start a marketing layout. Select a frame and choose Create size variants to create three editable copies with proportional content. Undo removes the whole batch. Import images through the canvas tools.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(BrandWorkspace, ownerDocument, CreatorMode.Brand),
});
