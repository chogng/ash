import type { IAction } from '../../../../../../base/common/actions.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { WorkbenchToolBar } from '../../../../../../platform/actions/browser/toolbar.js';
import { ISessionsLayoutService } from '../../../../../services/layout/common/sessionsLayoutService.js';
import { CreatorCanvasWorkspace } from '../../../browser/creatorCanvasWorkspace.js';
import { registerCreatorMode } from '../../../browser/creatorWorkspace.js';
import { CreatorMode, getCreatorModeTitle } from '../../../common/creator.js';

class DesignWorkspace extends CreatorCanvasWorkspace {
	private agentToolbar!: WorkbenchToolBar;
	constructor(ownerDocument: Document, mode: CreatorMode,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService private readonly agentContextMenus: IContextMenuService,
		@ISessionsLayoutService private readonly layoutService: ISessionsLayoutService,
		@ICommandService private readonly commandService: ICommandService,
	) { super(ownerDocument, mode, instantiation, agentContextMenus); }

	protected override createModeContent(): void {
		this.agentToolbar = this._register(new WorkbenchToolBar(this.actionsDomNode, this.agentContextMenus, { ariaLabel: localize('sessions.creator.design.agentActions', 'Design Agent actions') }));
		this._register(this.layoutService.onDidChangeConversationVisibility(() => this.updateActions()));
	}

	protected override getModeActions(): readonly IAction[] {
		return [
			this.action('frame', localize('sessions.design.addFrame', 'Add frame (F)'), () => this.editor.addFrame()),
			this.action('image', localize('sessions.design.importImage', 'Import image'), () => this.editor.importImage()),
		];
	}

	protected override updateActions(): void {
		super.updateActions();
		this.agentToolbar.setActions([
			this.action('agent', this.layoutService.conversationVisible ? localize('sessions.creator.design.hideAgent', 'Hide Agent') : localize('sessions.creator.design.showAgent', 'Show Agent'), () => this.layoutService.setConversationVisible(!this.layoutService.conversationVisible)),
			this.action('agentContext', localize('sessions.creator.design.addToAgent', 'Add design to Agent'), () => {
				// Capture at the user's action: later canvas edits must not change an attachment already in the draft.
				const document = this.document.model.value;
				return this.commandService.executeCommand('sessions.addContextToAgent', {
					id: `design-context:${document.documentId}`, name: 'design-context.json',
					content: JSON.stringify({ document, version: this.document.model.version, selectedShapeIds: [...this.editor.selection.ids] }, undefined, 2),
				});
			}),
		]);
	}
}

registerCreatorMode({
	id: CreatorMode.Design,
	title: getCreatorModeTitle(CreatorMode.Design),
	description: localize('sessions.creator.design.description', 'Design interfaces, components and vector artwork.'),
	icon: Lxicon.design,
	help: localize('sessions.creator.design.help', 'Design uses the canvas, Layers and Shape properties. Show Agent opens the shared conversation beside the canvas. Hide Agent returns focus to the canvas and keeps the draft. Add design to Agent attaches a snapshot of the document and selected objects; enter a request before sending. Add a frame or import an image. Draw, Motion and Code are editing tools within this workspace.'),
	create: (instantiation, ownerDocument) => instantiation.createInstance(DesignWorkspace, ownerDocument, CreatorMode.Design),
});
