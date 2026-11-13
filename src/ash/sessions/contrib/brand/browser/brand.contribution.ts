import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';
import type { ArtifactCanvasShape } from '../../artifact/common/model/artifactCanvasDocument.js';

const HasSelectedBrandFrame = new RawContextKey<boolean>('sessions.artifacts.brand.hasSelectedFrame', false);

class BrandWorkspace extends ArtifactWorkspace {
	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Brand, [
			{ id: 'square', title: localize2('sessions.artifacts.brand.square', 'Square asset'), run: workspace => workspace.addFrame(1080, 1080) },
			{ id: 'portrait', title: localize2('sessions.artifacts.brand.portrait', 'Portrait asset'), run: workspace => workspace.addFrame(1080, 1920) },
			{ id: 'landscape', title: localize2('sessions.artifacts.brand.landscape', 'Landscape asset'), run: workspace => workspace.addFrame(1200, 628) },
			{ id: 'variants', title: localize2('sessions.artifacts.brand.variants', 'Create size variants'), precondition: HasSelectedBrandFrame.isEqualTo(true), run: workspace => workspace.createVariants() },
		]);
	}

	private get selectedFrame(): ArtifactCanvasShape | undefined {
		return this.document.model.value.shapes.find(shape => shape.kind === 'frame' && this.editor.selection.ids.has(shape.id));
	}

	private createVariants(): void {
		const frame = this.selectedFrame;
		if (frame?.kind !== 'frame') { return; }
		const clone = (shape: ArtifactCanvasShape): ArtifactCanvasShape => {
			const copy = { ...shape, id: generateUuid() };
			return copy.kind === 'frame' || copy.kind === 'group' ? { ...copy, children: copy.children.map(clone) } : copy;
		};
		const right = Math.max(...this.document.model.value.shapes.map(shape => shape.x + shape.width));
		const variants = [[1080, 1080], [1080, 1920], [1200, 628]].map(([width, height], index): ArtifactCanvasShape => ({
			...frame, id: generateUuid(), x: right + 40 + index * 1240, y: frame.y, width, height,
			children: frame.children.length === 0 ? [] : [{ id: generateUuid(), kind: 'group', x: 0, y: 0, width: Math.min(width / frame.width, height / frame.height) * frame.width, height: Math.min(width / frame.width, height / frame.height) * frame.height, rotation: 0, fill: frame.fill, contentWidth: frame.width, contentHeight: frame.height, children: frame.children.map(clone) }],
		}));
		this.document.model.applyEdit([...this.document.model.value.shapes, ...variants]);
		this.editor.revealShape(variants[0].id);
	}
	protected override bindToolbarContext(contextKeys: IContextKeyService): () => void {
		const hasSelectedFrame = HasSelectedBrandFrame.bindTo(contextKeys);
		return () => hasSelectedFrame.set(this.selectedFrame !== undefined);
	}
}

BrandWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Brand,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Brand),
	description: localize('sessions.artifacts.brand.description', 'Create campaign artwork and generate size variants.'),
	icon: Lxicon.symbolColor,
	help: localize('sessions.artifacts.brand.help', 'Choose Square asset, Portrait asset or Landscape asset to start a marketing layout. Select a frame and choose Create size variants to create three editable copies with proportional content. Undo removes the whole batch. Import images through the canvas tools.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(BrandWorkspace, ownerDocument, ArtifactWorkspaceId.Brand));
