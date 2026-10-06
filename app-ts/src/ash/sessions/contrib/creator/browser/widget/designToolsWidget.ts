import './designToolsWidget.css';
import { h } from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IContextMenuProvider } from '../../../../../base/browser/contextmenu.js';
import type { Button } from '../../../../../base/browser/ui/button/button.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';

import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';

export const designToolActions = [
	[DesignTool.Select, 'sessions.design.selectTool', 'Select (V)', Lxicon.cursor2],
	[DesignTool.Hand, 'sessions.design.handTool', 'Move canvas (H)', Lxicon.hand],
	[DesignTool.Rectangle, 'sessions.design.rectangle', 'Rectangle', Lxicon.square],
	[DesignTool.Ellipse, 'sessions.design.ellipse', 'Ellipse', Lxicon.circleLarge],
	[DesignTool.Pen, 'sessions.design.penTool', 'Pen (P)', Lxicon.pen],
	[DesignTool.Text, 'sessions.design.textTool', 'Text (T)', Lxicon.text2],
] as const;

export const designModeActions = [
	[DesignMode.Draw, 'sessions.design.drawMode', 'Draw', Lxicon.pen],
	[DesignMode.Design, 'sessions.design.designMode', 'Design', Lxicon.design],
	[DesignMode.Motion, 'sessions.design.motionMode', 'Motion', Lxicon.motion],
	[DesignMode.Code, 'sessions.design.codeMode', 'Code', Lxicon.code],
] as const;

registerColor('sessions.design.chromeBackground', { light: '#181818', dark: '#181818', highContrastDark: '#000000', highContrastLight: '#ffffff' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeBackground', 'Background of the Design toolbar and menus.') });
registerColor('sessions.design.chromeForeground', { light: '#f0f0f0', dark: '#f0f0f0', highContrastDark: '#ffffff', highContrastLight: '#000000' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeForeground', 'Foreground of the Design toolbar and menus.') });

/** Owns tool chrome and keyboard navigation; the editor owns the active tool and mode. */
export class DesignToolsWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly tools: ActionBar;
	private readonly modes: ActionBar;
	private readonly toolActions = new Map<DesignTool, IAction>();
	private readonly documentActions: readonly IAction[];
	private readonly modeActions = new Map<DesignMode, IAction>();
	private pointerTool = DesignTool.Select;
	private shapeTool = DesignTool.Rectangle;
	private menuVisible = false;
	private renderedState: { tool: DesignTool; mode: DesignMode; isBusy: boolean; } | undefined;

	constructor(ownerDocument: Document, selectTool: (tool: DesignTool) => unknown, selectMode: (mode: DesignMode) => unknown, runDocumentAction: (action: string) => unknown, @IContextMenuService contextMenus: IContextMenuService) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-design-tools-widget' });
		this.documentActions = ([['addFrame', 'sessions.design.addFrame', 'Add frame (F)', Lxicon.square], ['importImage', 'sessions.design.importImage', 'Import image', Lxicon.add]] as const).map(([id, key, label, icon]) => ({ id: `sessions.design.${id}`, label: localize(key, label), tooltip: localize(key, label), icon, enabled: true, run: () => runDocumentAction(id) }));
		const tools = h(ownerDocument, 'div', { className: 'ash-design-tools-group' });
		const modes = h(ownerDocument, 'div', { className: 'ash-design-tools-group ash-design-modes' });
		this.domNode.append(tools, modes);
		const menuProvider: IContextMenuProvider = {
			showContextMenu: delegate => {
				contextMenus.showContextMenu({ ...delegate, getMenuClassName: () => 'ash-design-menu', getCheckedActionsRepresentation: () => 'radio', onHide: cancelled => { this.menuVisible = false; delegate.onHide?.(cancelled); } });
				this.menuVisible = true;
			},
		};
		this._register(toDisposable(() => { if (this.menuVisible) { contextMenus.hideContextMenu(); } }));
		this.tools = this._register(new ActionBar(tools, {
			ariaLabel: localize('sessions.design.tools', 'Design tools'),
			highlightToggledItems: true,
			actionViewItemProvider: action => {
				const pointer = action.id === 'sessions.design.tool.pointer';
				if (!pointer && action.id !== 'sessions.design.tool.shape') { return new DesignToolViewItem(action); }
				const label = pointer ? localize('sessions.design.pointerTools', 'Selection tools') : localize('sessions.design.shapeTools', 'Shape tools');
				const dropdown: IAction = { id: `${action.id}.menu`, label, tooltip: label, enabled: action.enabled, run: () => undefined };
				const items = pointer ? [DesignTool.Select, DesignTool.Hand] : [DesignTool.Rectangle, DesignTool.Ellipse];
				return new DesignToolDropdownViewItem(action, dropdown, () => items.map(tool => this.toolActions.get(tool)!), menuProvider);
			},
		}));
		this.modes = this._register(new ActionBar(modes, { ariaLabel: localize('sessions.design.modes', 'Editor modes'), highlightToggledItems: true, actionViewItemProvider: action => new DesignToolViewItem(action) }));
		for (const [tool, key, fallback, icon] of designToolActions) {
			const label = localize(key, fallback);
			this.toolActions.set(tool, { id: `sessions.design.tool.${tool}`, label, tooltip: label, icon, enabled: true, checked: false, run: () => selectTool(tool) });
		}
		for (const [mode, key, fallback, icon] of designModeActions) {
			const label = localize(key, fallback);
			this.modeActions.set(mode, { id: `sessions.design.mode.${mode}`, label, tooltip: label, icon, enabled: true, checked: false, run: () => selectMode(mode) });
		}
	}

	public update(tool: DesignTool, mode: DesignMode, isBusy: boolean): void {
		if (this.renderedState?.tool === tool && this.renderedState.mode === mode && this.renderedState.isBusy === isBusy) { return; }
		this.renderedState = { tool, mode, isBusy };
		if (tool === DesignTool.Select || tool === DesignTool.Hand) { this.pointerTool = tool; }
		if (tool === DesignTool.Rectangle || tool === DesignTool.Ellipse) { this.shapeTool = tool; }
		for (const [value, action] of this.toolActions) {
			this.toolActions.set(value, { ...action, checked: value === tool, enabled: !isBusy && mode !== DesignMode.Code });
		}
		this.tools.updateActions([
			{ ...this.toolActions.get(this.pointerTool)!, id: 'sessions.design.tool.pointer' },
			{ ...this.toolActions.get(this.shapeTool)!, id: 'sessions.design.tool.shape' },
			this.toolActions.get(DesignTool.Pen)!,
			this.toolActions.get(DesignTool.Text)!,
			...this.documentActions.map(action => ({ ...action, enabled: !isBusy && mode !== DesignMode.Code && mode !== DesignMode.Motion })),
		]);
		this.modes.updateActions([...this.modeActions].map(([value, action]) => ({ ...action, checked: value === mode })));
	}
}

class DesignToolDropdownViewItem extends DropdownWithPrimaryActionViewItem {
	public override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('ash-design-tool-split');
		const primary = container.querySelector<HTMLButtonElement>('.ash-dropdown-with-primary-primary button')!;
		primary.classList.add('icon-only');
		primary.setAttribute('aria-label', this.action.label);
	}
}

class DesignToolViewItem extends ActionViewItem {
	private button: Button | undefined;

	constructor(action: IAction) { super(action); }

	public override render(container: HTMLElement): void {
		this.button = this.createButton(container, { label: this.action.label, title: this.action.tooltip, icon: this.action.icon, iconOnly: true, checked: this.action.checked, enabled: this.action.enabled, onClick: () => this.action.run() });
	}

	public override setTabbable(tabbable: boolean): void { this.button!.domNode.tabIndex = tabbable ? 0 : -1; }
	public override focus(): void { this.button!.focus(); }
}
