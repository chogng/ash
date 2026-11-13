import './designWorkspace.css';
import { h } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ArtifactWorkspace } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId } from '../../artifact/common/artifactWorkspace.js';
import { ArtifactCanvasMode } from '../../artifact/common/config/artifactCanvasEditorConfiguration.js';
import { generateDesignCode } from './code/designCodeGenerator.js';
import { IArtifactCanvasEditorService } from '../../artifact/browser/artifactCanvasEditorService.js';

/** Visual editing, generated source and HTML preview share the same Design document. */
export class DesignWorkspace extends ArtifactWorkspace {
	private previewDomNode!: HTMLIFrameElement;
	private visible = false;
	private previewVisible = false;

	constructor(
		ownerDocument: Document,
		mode: ArtifactWorkspaceId,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IArtifactCanvasEditorService editors: IArtifactCanvasEditorService,
		@ICommandService private readonly commandService: ICommandService,
	) { super(ownerDocument, mode, instantiation, contextKeys, editors); }

	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Design, [
			{ id: 'agent', title: localize2('sessions.design.buildWithAgent', 'Build with Agent'), run: workspace => workspace.buildWithAgent() },
			{ id: 'previewHtml', title: localize2('sessions.design.previewHtml', 'Preview HTML'), run: workspace => workspace.togglePreview() },
		]);
	}

	protected override createModeContent(): void {
		this.domNode.classList.add('ash-design-workspace');
		this.previewDomNode = h(this.ownerDocument, 'iframe', {
			className: 'ash-design-html-preview',
			attributes: { title: localize('sessions.design.runningPreview', 'Running preview'), sandbox: 'allow-scripts' },
		});
		this.previewDomNode.hidden = true;
		this.contentDomNode.append(this.previewDomNode);
		this._register(this.document.model.onDidChange(() => this.refreshPreview()));
	}

	private togglePreview(): void {
		this.previewVisible = !this.previewVisible;
		this.previewDomNode.hidden = !this.previewVisible;
		this.editor.setMode(this.previewVisible ? ArtifactCanvasMode.Code : ArtifactCanvasMode.Design);
		this.refreshPreview();
	}

	private refreshPreview(): void {
		// Hidden previews release scripts; the document remains with its existing owner.
		this.previewDomNode.srcdoc = this.visible && this.previewVisible
			? generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()) : '';
	}

	private buildWithAgent(): Promise<unknown> {
		return this.commandService.executeCommand('sessions.design.buildWithAgent', {
			content: generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()),
		});
	}

	public override setVisible(visible: boolean): void {
		this.visible = visible;
		super.setVisible(visible);
		this.refreshPreview();
	}
}
