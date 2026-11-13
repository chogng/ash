import './makeWorkspace.css';
import { h } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ArtifactWorkspace, registerArtifactWorkspaceMode } from '../../artifact/browser/artifactWorkspace.js';
import { ArtifactWorkspaceId, getArtifactWorkspaceTitle } from '../../artifact/common/artifactWorkspace.js';
import { DesignMode } from '../../artifact/common/config/designEditorConfiguration.js';
import { generateDesignCode } from '../../artifact/browser/code/designCodeGenerator.js';

class MakeWorkspace extends ArtifactWorkspace {
	public override readonly detailsContainerId = undefined;
	public override readonly conversationKind = 'code';
	private previewDomNode!: HTMLIFrameElement;
	private promptDomNode!: HTMLTextAreaElement;
	private visible = false;
	constructor(
		ownerDocument: Document,
		mode: ArtifactWorkspaceId,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@ICommandService private readonly commandService: ICommandService,
	) { super(ownerDocument, mode, instantiation, contextKeys); }

	public static registerToolbarActions(): void {
		this.registerWorkspaceActions(ArtifactWorkspaceId.Make, [
			{ id: 'agent', title: localize2('sessions.creator.make.agent', 'Build with Agent'), run: workspace => workspace.buildWithAgent() },
			{ id: 'edit', title: localize2('sessions.creator.make.edit', 'Edit canvas'), run: workspace => workspace.editor.setMode(DesignMode.Design) },
			{ id: 'code', title: localize2('sessions.creator.make.code', 'View code'), run: workspace => workspace.editor.setMode(DesignMode.Code) },
		]);
	}
	protected override createModeContent(): void {
		this.editor.setMode(DesignMode.Code);
		this.domNode.classList.add('ash-creator-make');
		this.promptDomNode = h(this.ownerDocument, 'textarea', { className: 'ash-creator-make-prompt', attributes: { 'aria-label': localize('sessions.creator.make.prompt', 'Describe what to build'), placeholder: localize('sessions.creator.make.prompt', 'Describe what to build'), rows: '2' } });
		this.domNode.insertBefore(this.promptDomNode, this.contentDomNode);
		this.previewDomNode = h(this.ownerDocument, 'iframe', { className: 'ash-creator-make-preview', attributes: { title: localize('sessions.creator.make.preview', 'Running preview'), sandbox: 'allow-scripts' } });
		this.contentDomNode.append(this.previewDomNode);
		const refresh = (): void => { if (this.visible) { this.previewDomNode.srcdoc = generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()); } };
		this._register(this.document.model.onDidChange(refresh));
		refresh();
	}
	private buildWithAgent(): Promise<unknown> {
		return this.commandService.executeCommand('sessions.creator.buildWithAgent', {
			prompt: this.promptDomNode.value,
			content: generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()),
		});
	}
	public override setVisible(visible: boolean): void {
		this.visible = visible;
		super.setVisible(visible);
		// Hidden previews release their execution context; source and the unsent prompt stay in the workspace.
		this.previewDomNode.srcdoc = visible ? generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()) : '';
	}
}

MakeWorkspace.registerToolbarActions();
registerArtifactWorkspaceMode({
	id: ArtifactWorkspaceId.Make,
	title: getArtifactWorkspaceTitle(ArtifactWorkspaceId.Make),
	description: localize('sessions.creator.make.description', 'View generated code, run a preview and continue with an Agent.'),
	icon: Lxicon.code,
	help: localize('sessions.creator.make.help', 'View code shows generated HTML, CSS and scene JSON. Edit canvas returns to visual editing and updates the running preview. Describe what to build and choose Build with Agent to prepare a Code conversation with the current HTML attached; review and send the request there.'),
}, (instantiation, ownerDocument) => instantiation.createInstance(MakeWorkspace, ownerDocument, ArtifactWorkspaceId.Make));
