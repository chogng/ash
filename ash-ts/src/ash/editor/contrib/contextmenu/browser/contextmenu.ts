import { type ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { type IMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { IContextKeyService, type IContextKeyService as IContextKeyServiceContract } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IContextMenuService, type IContextMenuService as IContextMenuServiceContract } from '../../../../platform/contextview/browser/contextView.js';
import { type ICodeEditor, type IEditorMouseEvent, MouseTargetType } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';

/** Presents the editor menu through the shared platform context-menu service. */
export class ContextMenuController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.contextmenu';

	public static get(editor: ICodeEditor): ContextMenuController | null {
		return editor.getContribution<ContextMenuController>(ContextMenuController.ID);
	}

	private readonly contextMenuService: IContextMenuServiceContract | undefined;
	private readonly contextKeyService: IContextKeyServiceContract | undefined;

	constructor(private readonly editor: ICodeEditor) {
		super();
		this.contextMenuService = editor.invokeWithinContext(accessor => accessor.getOptional(IContextMenuService));
		this.contextKeyService = editor.invokeWithinContext(accessor => accessor.getOptional(IContextKeyService));
		this._register(editor.onContextMenu(event => this.onContextMenu(event)));
		this._register(editor.onKeyDown(event => this.onKeyDown(event)));
	}

	public showContextMenu(anchor?: IMouseEvent | null): void {
		if (!this.contextMenuService || !this.editor.hasModel() || !this.editor.getOption(EditorOption.contextmenu)) return;
		const resolvedAnchor = anchor ? this.mouseAnchor(anchor) : this.keyboardAnchor();
		if (!resolvedAnchor) return;
		this.contextMenuService.showContextMenu({
			menuId: this.editor.contextMenuId,
			contextKeyService: this.contextKeyService,
			menuActionOptions: { arg: this.editor.getModel()?.uri },
			getAnchor: () => resolvedAnchor,
			onHide: () => this.editor.focus(),
		});
	}

	private onContextMenu(event: IEditorMouseEvent): void {
		if (!this.editor.hasModel()) return;
		if (!this.editor.getOption(EditorOption.contextmenu)) {
			this.editor.focus();
			if (event.target.position && !this.editor.getSelection()?.containsPosition(event.target.position)) this.editor.setPosition(event.target.position);
			return;
		}
		if (event.target.type === MouseTargetType.OVERLAY_WIDGET || event.target.type === MouseTargetType.CONTENT_WIDGET) return;
		if (event.target.type === MouseTargetType.CONTENT_TEXT && event.target.detail.injectedText) return;
		event.event.preventDefault();
		event.event.stopPropagation();
		this.editor.focus();
		const position = event.target.position;
		if (position && !(this.editor.getSelections() ?? []).some(selection => selection.containsPosition(position))) this.editor.setPosition(position, 'contextmenu');
		this.showContextMenu(event.event);
	}

	private onKeyDown(event: IKeyboardEvent): void {
		const isContextMenuKey = event.keyCode === KeyCode.ContextMenu
			|| (event.keyCode === KeyCode.F10 && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey);
		if (!isContextMenuKey || !this.editor.getOption(EditorOption.contextmenu)) return;
		event.stop();
		this.showContextMenu();
	}

	private mouseAnchor(event: IMouseEvent): ContextMenuAnchor {
		return {
			x: event.clientX,
			y: event.clientY,
			targetWindow: this.editor.getDomNode()?.ownerDocument.defaultView ?? undefined,
		};
	}

	private keyboardAnchor(): ContextMenuAnchor | undefined {
		const position = this.editor.getPosition();
		const domNode = this.editor.getDomNode();
		if (!position || !domNode) return undefined;
		this.editor.revealRange(Range.fromPositions(position));
		const visible = this.editor.getScrolledVisiblePosition(position);
		if (!visible) return domNode;
		const bounds = domNode.getBoundingClientRect();
		return {
			x: bounds.left + visible.left,
			y: bounds.top + visible.top + visible.height,
			targetWindow: domNode.ownerDocument.defaultView ?? undefined,
		};
	}
}

class ShowContextMenu extends EditorAction {
	constructor() {
		super({ id: 'editor.action.showContextMenu', label: nls.localize2('action.showContextMenu.label', 'Show Editor Context Menu'), precondition: undefined });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		ContextMenuController.get(editor)?.showContextMenu();
	}
}

registerEditorContribution(ContextMenuController.ID, ContextMenuController, EditorContributionInstantiation.BeforeFirstInteraction);
registerEditorAction(ShowContextMenu);
