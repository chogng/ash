import './makeWorkspace.css';
import { h } from '../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { CreatorModes } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';
import { DesignMode } from '../../../common/config/editorConfiguration.js';
import { generateDesignCode } from '../../code/browser/designCodeGenerator.js';

class MakeWorkspace extends CreatorCanvasWorkspace {
	public override readonly usesCanvasPanels = false;
	private previewDomNode!: HTMLIFrameElement;
	private promptDomNode!: HTMLTextAreaElement;
	private visible = false;
	constructor(ownerDocument: Document, mode: CreatorMode, @IInstantiationService instantiation: IInstantiationService, @IContextMenuService contextMenus: IContextMenuService, @ICommandService private readonly commandService: ICommandService) { super(ownerDocument, mode, instantiation, contextMenus); }
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
	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('agent', localize('sessions.creator.make.agent', 'Build with Agent'), () => this.commandService.executeCommand('sessions.creator.buildWithAgent', { prompt: this.promptDomNode.value, content: generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()) })),
			this.action('edit', localize('sessions.creator.make.edit', 'Edit canvas'), () => this.editor.setMode(DesignMode.Design)),
			this.action('code', localize('sessions.creator.make.code', 'View code'), () => this.editor.setMode(DesignMode.Code)),
		];
	}
	public override setVisible(visible: boolean): void {
		this.visible = visible;
		super.setVisible(visible);
		// Hidden previews release their execution context; source and the unsent prompt stay in the workspace.
		this.previewDomNode.srcdoc = visible ? generateDesignCode(this.document.model.value, this.document.getEmbeddedImageSources()) : '';
	}
}

CreatorModes.set(CreatorMode.Make, {
	id: CreatorMode.Make,
	title: getCreatorModeTitle(CreatorMode.Make),
	description: localize('sessions.creator.make.description', 'View generated code, run a preview and continue with an Agent.'),
	icon: Lxicon.code,
	help: localize('sessions.creator.make.help', 'View code shows generated HTML, CSS and scene JSON. Edit canvas returns to visual editing and updates the running preview. Describe what to build and choose Build with Agent to prepare a Code conversation with the current HTML attached; review and send the request there.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(MakeWorkspace, ownerDocument, CreatorMode.Make),
});
