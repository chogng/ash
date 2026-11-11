import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CanvasWorkspace } from '../../../browser/canvasWorkspace.js';
import { CanvasFrameNavigator } from '../../../browser/canvasFrameNavigator.js';
import { registerArtifactWorkspace } from '../../../browser/artifactWorkspaceRegistry.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../../common/artifactWorkspace.js';

class SlidesWorkspace extends CanvasWorkspace {
	private pages!: CanvasFrameNavigator;
	protected override createModeContent(): void {
		this.pages = this._register(new CanvasFrameNavigator(this.actionsDomNode, this.contentDomNode, this.document, id => this.editor.revealShape(id)));
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
	protected override getModeActions(): readonly IAction[] {
		const index = this.pages.frames.findIndex(frame => frame.id === this.pages.selectedId);
		return [
			this.action('add', localize('sessions.creator.slides.add', 'Add slide'), () => this.pages.select(this.addFrame(1280, 720))),
			this.action('earlier', localize('sessions.creator.slides.earlier', 'Move slide earlier'), () => this.reorder(-1), index > 0),
			this.action('later', localize('sessions.creator.slides.later', 'Move slide later'), () => this.reorder(1), index >= 0 && index < this.pages.frames.length - 1),
			this.action('present', localize('sessions.creator.slides.present', 'Present'), () => this.pages.showPreview(true), this.pages.frames.length > 0),
		];
	}
	public override focus(): void { if (this.pages.isPresenting) { this.pages.focus(); } else { super.focus(); } }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.pages.setVisible(visible); }
}

registerArtifactWorkspace({
	id: ArtifactWorkspaceId.Slides,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Slides),
	description: localize('sessions.creator.slides.description', 'Build a slide deck, arrange pages and present your work.'),
	icon: Lxicon.layout,
	help: localize('sessions.creator.slides.help', 'Add slide creates a 16:9 slide. Pages selects a slide for editing. Move slide earlier and Move slide later change presentation order and support Undo. Present plays the deck; use Left and Right on the preview to change pages and Escape to return to editing.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(SlidesWorkspace, ownerDocument, ArtifactWorkspaceId.Slides),
});
