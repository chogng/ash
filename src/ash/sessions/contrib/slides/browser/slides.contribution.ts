import { registerArtifactDesignDocument } from '../../artifact/browser/artifactDesignCatalog.js';
import { registerArtifactExample } from '../../artifact/browser/artifactExamples.js';
import { frame, geometry, text } from '../../artifact/browser/artifactExampleShapes.js';
import { openManagedArtifactDesign } from '../../artifact/browser/artifactDesignWorkspaces.js';
import { IDesignEditorService } from '../../artifact/browser/designEditorService.js';
import type { DesignShape } from '../../artifact/common/model/designDocument.js';
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
			{ id: 'add', title: localize2('sessions.creator.slides.add', 'Add slide'), run: workspace => workspace.pages.select(workspace.addFrame(1280, 720)) },
			{ id: 'earlier', title: localize2('sessions.creator.slides.earlier', 'Move slide earlier'), precondition: CanMoveSlideEarlier.isEqualTo(true), run: workspace => workspace.reorder(-1) },
			{ id: 'later', title: localize2('sessions.creator.slides.later', 'Move slide later'), precondition: CanMoveSlideLater.isEqualTo(true), run: workspace => workspace.reorder(1) },
			{ id: 'present', title: localize2('sessions.creator.slides.present', 'Present'), precondition: HasSlides.isEqualTo(true), run: workspace => workspace.pages.showPreview(true) },
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
	description: localize('sessions.creator.slides.description', 'Build a slide deck, arrange pages and present your work.'),
	icon: Lxicon.layout,
	help: localize('sessions.creator.slides.help', 'Add slide creates a 16:9 slide. Pages selects a slide for editing. Move slide earlier and Move slide later change presentation order and support Undo. Present plays the deck; use Left and Right on the preview to change pages and Escape to return to editing.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(SlidesWorkspace, ownerDocument, ArtifactWorkspaceId.Slides));

registerArtifactDesignDocument('slides', () => getArtifactWorkspaceTitle(ArtifactWorkspaceId.Slides));

registerArtifactExample('slides', () => ({
	detail: localize('sessions.artifacts.exampleSlides', 'A two-slide deck with presentation mode'),
	open: accessor => openManagedArtifactDesign(accessor, accessor.get(IDesignEditorService).createArtifactDocument('slides', createSlides())),
}));

function createSlides(): readonly DesignShape[] {
	const launch = localize('sessions.artifacts.exampleLaunch', 'Studio launch');
	return [
		frame(0, 1280, 720, '#191e33', launch, [
			text(84, 94, 1050, localize('sessions.artifacts.examplePilot', 'Pilot'), 32, '#b8ec79', 600),
			text(84, 242, 1110, launch, 112, '#ffffff', 700),
			text(84, 435, 990, localize('sessions.artifacts.exampleSlidesTagline', 'A shared home for the studio’s work'), 42, '#cad0e6'),
			{ ...geometry(84, 602, 300, 10, '#b8ec79'), kind: 'rectangle' },
		]),
		frame(1320, 1280, 720, '#eff1f8', localize('sessions.artifacts.exampleSchedule', 'Launch schedule'), [
			text(84, 86, 1100, localize('sessions.artifacts.exampleSchedule', 'Launch schedule'), 70, '#191e33', 700),
			...[
				localize('sessions.artifacts.examplePilot', 'Pilot'),
				localize('sessions.artifacts.exampleFeedback', 'Review feedback'),
				localize('sessions.artifacts.exampleRelease', 'Publish launch notes'),
			].map((step, index) => text(90, 244 + index * 112, 1010, `${index + 1}. ${step}`, 50, '#424f75', 600)),
		]),
	];
}
