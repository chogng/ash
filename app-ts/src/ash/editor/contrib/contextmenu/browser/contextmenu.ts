import { type ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { type IMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { type IAction, Separator, SubmenuAction } from '../../../../base/common/actions.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import * as nls from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { type ICodeEditor, type IEditorMouseEvent, MouseTargetType } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorOption, type IEditorMinimapOptions } from '../../../common/config/editorOptions.js';
import { EditorMinimapConfiguration } from '../../../common/config/editorConfigurationSchema.js';
import { Range } from '../../../common/core/range.js';
import { type IEditorContribution } from '../../../common/editorCommon.js';

/** Presents the editor menu through the shared platform context-menu service. */
export class ContextMenuController extends Disposable implements IEditorContribution {
	public static readonly ID = 'editor.contrib.contextmenu';

	public static get(editor: ICodeEditor): ContextMenuController | null {
		return editor.getContribution<ContextMenuController>(ContextMenuController.ID);
	}

	private activeMenu: object | undefined;

	constructor(
		private readonly editor: ICodeEditor,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(editor.onContextMenu(event => this.onContextMenu(event)));
		this._register(editor.onKeyDown(event => this.onKeyDown(event)));
		this._register(editor.onMouseWheel(() => {
			if (this.activeMenu) {
				this.contextMenuService.hideContextMenu();
			}
		}));
		this._register(toDisposable(() => {
			if (this.activeMenu) {
				this.contextMenuService.hideContextMenu();
			}
		}));
	}

	public showContextMenu(anchor?: IMouseEvent | null): void {
		if (!this.editor.hasModel() || !this.editor.getOption(EditorOption.contextmenu)) return;
		const resolvedAnchor = anchor ? this.mouseAnchor(anchor) : this.keyboardAnchor();
		if (!resolvedAnchor) return;
		const menu = this.activeMenu = {};
		this.contextMenuService.showContextMenu({
			menuId: this.editor.contextMenuId,
			contextKeyService: this.contextKeyService,
			menuActionOptions: { arg: this.editor.getModel()?.uri },
			getAnchor: () => resolvedAnchor,
			onHide: () => this.onMenuHide(menu),
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
		if (event.target.type === MouseTargetType.SCROLLBAR) {
			this.showScrollbarContextMenu(event.event);
			return;
		}
		if (event.target.type !== MouseTargetType.CONTENT_TEXT
			&& event.target.type !== MouseTargetType.CONTENT_EMPTY
			&& event.target.type !== MouseTargetType.TEXTAREA) return;
		this.editor.focus();
		const position = event.target.position;
		if (position && !(this.editor.getSelections() ?? []).some(selection => selection.containsPosition(position))) this.editor.setPosition(position, 'contextmenu');
		this.showContextMenu(event.target.type === MouseTargetType.TEXTAREA ? null : event.event);
	}

	private showScrollbarContextMenu(event: IMouseEvent): void {
		const minimap = this.editor.getOption(EditorOption.minimap);
		const action = (
			id: string,
			label: string,
			checked: boolean,
			enabled: boolean,
			run: () => Promise<void>,
		): IAction => ({ id, label, tooltip: '', checked, enabled, run });
		const choice = <K extends 'size' | 'showSlider' | 'side'>(
			key: K,
			label: string,
			options: readonly { label: string; value: NonNullable<IEditorMinimapOptions[K]> }[],
		): IAction => {
			if (!minimap.enabled) {
				return {
					id: `editor.minimap.${key}`,
					label,
					tooltip: '',
					enabled: false,
					run() {},
				};
			}
			return new SubmenuAction(
				`editor.minimap.${key}`,
				label,
				options.map(({ label: optionLabel, value }) => action(
					`editor.minimap.${key}.${value}`,
					optionLabel,
					minimap[key] === value,
					true,
					() => this.updateMinimapOption(key, value),
				)),
			);
		};
		const actions: IAction[] = [
			action(
				'editor.minimap.enabled',
				nls.localize('context.minimap.enabled', 'Minimap'),
				minimap.enabled,
				true,
				() => this.updateMinimapOption('enabled', !minimap.enabled),
			),
			new Separator(),
			action(
				'editor.minimap.renderCharacters',
				nls.localize('context.minimap.renderCharacters', 'Render Characters'),
				minimap.renderCharacters,
				minimap.enabled,
				() => this.updateMinimapOption('renderCharacters', !minimap.renderCharacters),
			),
			choice('size', nls.localize('context.minimap.size', 'Vertical Size'), [
				{ label: nls.localize('context.minimap.size.proportional', 'Proportional'), value: 'proportional' },
				{ label: nls.localize('context.minimap.size.fill', 'Fill'), value: 'fill' },
				{ label: nls.localize('context.minimap.size.fit', 'Fit'), value: 'fit' },
			]),
			choice('showSlider', nls.localize('context.minimap.slider', 'Show Slider'), [
				{ label: nls.localize('context.minimap.slider.mouseover', 'Mouse Over'), value: 'mouseover' },
				{ label: nls.localize('context.minimap.slider.always', 'Always'), value: 'always' },
			]),
			choice('side', nls.localize('context.minimap.side', 'Side'), [
				{ label: nls.localize('context.minimap.side.right', 'Right'), value: 'right' },
				{ label: nls.localize('context.minimap.side.left', 'Left'), value: 'left' },
			]),
		];
		const menu = this.activeMenu = {};
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.mouseAnchor(event),
			getActions: () => actions,
			getCheckedActionsRepresentation: item =>
				item.id === 'editor.minimap.enabled' || item.id === 'editor.minimap.renderCharacters'
					? 'checkbox'
					: 'radio',
			onHide: () => this.onMenuHide(menu),
		});
	}

	private onMenuHide(menu: object): void {
		if (this.activeMenu !== menu) {
			return;
		}
		this.activeMenu = undefined;
		if (!this.isDisposed) {
			this.editor.focus();
		}
	}

	private async updateMinimapOption<K extends keyof typeof EditorMinimapConfiguration>(
		key: K,
		value: NonNullable<IEditorMinimapOptions[K]>,
	): Promise<void> {
		await this.configurationService.updateValue(EditorMinimapConfiguration[key], value);
		// A standalone editor has no workbench pane to apply configuration changes for it.
		if (!this.isDisposed) {
			this.editor.updateOptions({ minimap: { [key]: value } });
		}
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
