import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { CreatorFrameNavigator } from '../../../browser/creatorFrameNavigator.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';
import { documentFromShapes } from '../../../common/model/document.js';
import { exportDesignSvg } from '../../../browser/svgRenderer.js';

class SitesWorkspace extends CreatorCanvasWorkspace {
	private pages!: CreatorFrameNavigator;
	protected override createModeContent(): void {
		this.pages = this._register(new CreatorFrameNavigator(this.actionsDomNode, this.contentDomNode, this.document, id => this.editor.revealShape(id)));
	}
	private async exportWebsite(): Promise<void> {
		const frames = this.pages.frames;
		const navigation = frames.map((_, index) => `<a href="#page-${index}">${localize('sessions.creator.pageNumber', 'Page {0}', index + 1)}</a>`).join(' ');
		const sections = frames.map((frame, index) => `<section id="page-${index}">${exportDesignSvg(documentFromShapes([frame], this.document.model.value, this.document.model.value.assets), this.document.getEmbeddedImageSources())}</section>`).join('\n');
		await this.document.exportDocument({ title: localize('sessions.creator.sites.export', 'Export website'), filename: 'site.html', extension: 'html', content: `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Creator</title><style>body{margin:0;font:16px system-ui}nav{display:flex;flex-wrap:wrap;gap:16px;padding:16px}section{max-width:1440px;margin:0 auto 32px}section>svg{display:block;width:100%;height:auto}</style></head><body><nav>${navigation}</nav><main>${sections}</main></body></html>\n` });
	}
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('page', localize('sessions.creator.sites.addPage', 'Add web page'), () => this.pages.select(this.addFrame(1440, 900))),
			this.action('preview', localize('sessions.creator.sites.preview', 'Preview pages'), () => this.pages.showPreview(true), this.pages.frames.length > 0),
			this.action('export', localize('sessions.creator.sites.export', 'Export website'), () => this.exportWebsite(), this.pages.frames.length > 0),
		];
	}
	public override focus(): void { if (this.pages.isPresenting) { this.pages.focus(); } else { super.focus(); } }
	public override setVisible(visible: boolean): void { super.setVisible(visible); this.pages.setVisible(visible); }
}

registerCreatorMode({
	id: CreatorMode.Sites,
	title: getCreatorModeTitle(CreatorMode.Sites),
	description: localize('sessions.creator.sites.description', 'Design web pages, preview them and export a website.'),
	icon: Lxicon.code,
	help: localize('sessions.creator.sites.help', 'Add web page creates a website page. Pages selects the page to edit. Preview pages opens the page preview. Export website writes a standalone HTML file with page navigation and embedded artwork that scales to the browser width. Publishing and layout reflow are not available.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(SitesWorkspace, ownerDocument, CreatorMode.Sites),
});
