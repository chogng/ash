import { registerArtifactCanvasDocument } from '../../artifact/browser/artifactCanvasCatalog.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactFrameNavigator } from '../../artifact/browser/artifactFrameNavigator.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';

const CanMoveSlideEarlier = new RawContextKey<boolean>('sessions.artifacts.slides.canMoveEarlier', false);
const CanMoveSlideLater = new RawContextKey<boolean>('sessions.artifacts.slides.canMoveLater', false);
const HasSlides = new RawContextKey<boolean>('sessions.artifacts.slides.hasSlides', false);

class SlidesWorkspace extends ArtifactWorkspace {
	private pages!: ArtifactFrameNavigator;
	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Slides, [
			{ id: 'add', title: localize2('sessions.artifacts.slides.add', 'Add slide'), run: workspace => workspace.pages.select(workspace.addFrame(1280, 720)) },
			{ id: 'earlier', title: localize2('sessions.artifacts.slides.earlier', 'Move slide earlier'), precondition: CanMoveSlideEarlier.isEqualTo(true), run: workspace => workspace.reorder(-1) },
			{ id: 'later', title: localize2('sessions.artifacts.slides.later', 'Move slide later'), precondition: CanMoveSlideLater.isEqualTo(true), run: workspace => workspace.reorder(1) },
			{ id: 'present', title: localize2('sessions.artifacts.slides.present', 'Present'), precondition: HasSlides.isEqualTo(true), run: workspace => workspace.pages.showPreview(true) },
		]);
	}
	protected override createModeContent(): void {
		this.pages = this._register(new ArtifactFrameNavigator(this.createPageNavigation(), this.contentDomNode, this.document, id => this.editor.revealShape(id)));
	}
	private reorder(offset: number): void {
		const shapes = [...this.document.model.value.shapes];
		const frames = this.pages.frames;
		const index = frames.findIndex(frame => frame.id === this.pages.selectedId);
		const adjacent = frames[index + offset];
		if (!adjacent || index < 0) { return; }
		const source = shapes.indexOf(frames[index]);
		const target = shapes.indexOf(adjacent);
		[shapes[source], shapes[target]] = [shapes[target], shapes[source]];
		this.document.model.applyEdit(shapes);
	}
	protected override bindToolbarContext(contextKeys: IContextKeyService): () => void {
		const earlier = CanMoveSlideEarlier.bindTo(contextKeys);
		const later = CanMoveSlideLater.bindTo(contextKeys);
		const hasSlides = HasSlides.bindTo(contextKeys);
		const update = () => {
			const frames = this.pages.frames;
			const index = frames.findIndex(frame => frame.id === this.pages.selectedId);
			earlier.set(index > 0);
			later.set(index >= 0 && index < frames.length - 1);
			hasSlides.set(frames.length > 0);
		};
		this._register(this.pages.onDidChangeSelection(() => contextKeys.bufferChangeEvents(update)));
		return update;
	}
	public override focus(): void { if (this.pages.isPresenting) { this.pages.focus(); } else { super.focus(); } }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.pages.setVisible(visible); }
}

SlidesWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Slides,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Slides),
	description: localize('sessions.artifacts.slides.description', 'Build a slide deck, arrange pages and present your work.'),
	icon: Lxicon.layout,
	help: localize('sessions.artifacts.slides.help', 'Add slide creates a 16:9 slide. Pages selects a slide for editing. Move slide earlier and Move slide later change presentation order and support Undo. Present plays the deck; use Left and Right on the preview to change pages and Escape to return to editing.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(SlidesWorkspace, ownerDocument, ArtifactWorkspaceId.Slides));

registerArtifactCanvasDocument('slides', () => getArtifactWorkspaceTitle(ArtifactWorkspaceId.Slides));
