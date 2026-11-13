import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactFrameNavigator } from '../../artifact/browser/artifactFrameNavigator.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';
import { documentFromShapes } from '../../artifact/common/model/artifactCanvasDocument.js';
import { exportArtifactCanvasSvg } from '../../artifact/browser/rendering/artifactCanvasSvgRenderer.js';

const HasSitePages = new RawContextKey<boolean>('sessions.artifacts.sites.hasPages', false);

class SitesWorkspace extends ArtifactWorkspace {
	private pages!: ArtifactFrameNavigator;
	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Sites, [
			{ id: 'page', title: localize2('sessions.artifacts.sites.addPage', 'Add web page'), run: workspace => workspace.pages.select(workspace.addFrame(1440, 900)) },
			{ id: 'preview', title: localize2('sessions.artifacts.sites.preview', 'Preview pages'), precondition: HasSitePages.isEqualTo(true), run: workspace => workspace.pages.showPreview(true) },
			{ id: 'export', title: localize2('sessions.artifacts.sites.export', 'Export website'), precondition: HasSitePages.isEqualTo(true), run: workspace => workspace.exportWebsite() },
		]);
	}
	protected override createModeContent(): void {
		this.pages = this._register(new ArtifactFrameNavigator(this.createPageNavigation(), this.contentDomNode, this.document, id => this.editor.revealShape(id)));
	}
	private async exportWebsite(): Promise<void> {
		const frames = this.pages.frames;
		const navigation = frames.map((_, index) => `<a href="#page-${index}">${localize('sessions.artifacts.pageNumber', 'Page {0}', index + 1)}</a>`).join(' ');
		const sections = frames.map((frame, index) => `<section id="page-${index}">${exportArtifactCanvasSvg(documentFromShapes([frame], this.document.model.value, this.document.model.value.assets), this.document.getEmbeddedImageSources())}</section>`).join('\n');
		await this.document.exportDocument({ title: localize('sessions.artifacts.sites.export', 'Export website'), filename: 'site.html', extension: 'html', content: `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artifacts</title><style>body{margin:0;font:16px system-ui}nav{display:flex;flex-wrap:wrap;gap:16px;padding:16px}section{max-width:1440px;margin:0 auto 32px}section>svg{display:block;width:100%;height:auto}</style></head><body><nav>${navigation}</nav><main>${sections}</main></body></html>\n` });
	}
	protected override bindToolbarContext(contextKeys: IContextKeyService): () => void {
		const hasPages = HasSitePages.bindTo(contextKeys);
		return () => hasPages.set(this.pages.frames.length > 0);
	}
	public override focus(): void { if (this.pages.isPresenting) { this.pages.focus(); } else { super.focus(); } }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.pages.setVisible(visible); }
}

SitesWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Sites,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Sites),
	description: localize('sessions.artifacts.sites.description', 'Design web pages, preview them and export a website.'),
	icon: Lxicon.code,
	help: localize('sessions.artifacts.sites.help', 'Add web page creates a website page. Pages selects the page to edit. Preview pages opens the page preview. Export website writes a standalone HTML file with page navigation and embedded artwork that scales to the browser width. Publishing and layout reflow are not available.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(SitesWorkspace, ownerDocument, ArtifactWorkspaceId.Sites));
