import './designToolsWidget.css';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../../base/browser/observer.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { Button } from '../../../../../base/browser/ui/button/button.js';
import { ScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { localize } from '../../../../../nls.js';

import { DesignMode, DesignTool } from '../../common/config/editorConfiguration.js';

/** Owns tool chrome and keyboard navigation; the editor owns the active tool and mode. */
export class DesignToolsWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly tools: ActionBar;
	private readonly modes: ActionBar;
	private readonly toolActions = new Map<DesignTool, IAction>();
	private readonly modeActions = new Map<DesignMode, IAction>();

	constructor(container: HTMLElement, selectTool: (tool: DesignTool) => void, selectMode: (mode: DesignMode) => void) {
		super();
		const ownerDocument = container.ownerDocument;
		this.domNode = h(ownerDocument, 'div', { className: 'ash-design-tools-widget' });
		const scrollable = this._register(new ScrollableElement(this.domNode, { direction: 'horizontal', scrollbarSize: 4, tabIndex: -1 }));
		scrollable.element.classList.add('ash-design-tools-scroll');
		const row = h(ownerDocument, 'div', { className: 'ash-design-tools-row' });
		const tools = h(ownerDocument, 'div', { className: 'ash-design-tools-group' });
		const modes = h(ownerDocument, 'div', { className: 'ash-design-tools-group ash-design-modes' });
		row.append(tools, modes);
		scrollable.append(row);
		// Preserve the row's natural width while the canvas constrains its scroll viewport.
		this._register(observeElementSize(row, size => {
			this.domNode.style.setProperty('--ash-design-tools-content-width', `${size.width}px`);
			scrollable.layout();
		}));
		this._register(addDisposableListener(row, 'focusin', () => {
			const focused = ownerDocument.activeElement;
			if (focused && row.contains(focused)) { scrollable.reveal(focused); }
		}));
		this.tools = this._register(new ActionBar(tools, { ariaLabel: localize('sessions.design.tools', 'Design tools'), highlightToggledItems: true, actionViewItemProvider: action => new DesignToolViewItem(action) }));
		this.modes = this._register(new ActionBar(modes, { ariaLabel: localize('sessions.design.modes', 'Editor modes'), highlightToggledItems: true }));
		for (const [tool, label, icon] of [
			[DesignTool.Select, localize('sessions.design.selectTool', 'Select (V)'), Lxicon.cursor],
			[DesignTool.Hand, localize('sessions.design.handTool', 'Move canvas (H)'), Lxicon.hand],
			[DesignTool.Zoom, localize('sessions.design.zoomTool', 'Zoom canvas (Z)'), Lxicon.zoomIn],
			[DesignTool.Rectangle, localize('sessions.design.rectangle', 'Rectangle'), Lxicon.primitiveSquare],
			[DesignTool.Ellipse, localize('sessions.design.ellipse', 'Ellipse'), Lxicon.ellipse],
			[DesignTool.Pen, localize('sessions.design.penTool', 'Pen (P)'), Lxicon.pen],
			[DesignTool.Text, localize('sessions.design.textTool', 'Text (T)'), Lxicon.text],
		] as const) {
			this.toolActions.set(tool, { id: `sessions.design.tool.${tool}`, label, tooltip: label, icon, enabled: true, checked: false, run: () => selectTool(tool) });
		}
		for (const [mode, label] of [
			[DesignMode.Draw, localize('sessions.design.drawMode', 'Draw')],
			[DesignMode.Design, localize('sessions.design.designMode', 'Design')],
			[DesignMode.Motion, localize('sessions.design.motionMode', 'Motion')],
			[DesignMode.Code, localize('sessions.design.codeMode', 'Code')],
		] as const) {
			this.modeActions.set(mode, { id: `sessions.design.mode.${mode}`, label, tooltip: label, enabled: true, checked: false, run: () => selectMode(mode) });
		}
	}

	public update(tool: DesignTool, mode: DesignMode, isBusy: boolean): void {
		this.tools.updateActions([...this.toolActions].map(([value, action]) => ({ ...action, checked: value === tool, enabled: !isBusy && mode !== DesignMode.Code })));
		this.modes.updateActions([...this.modeActions].map(([value, action]) => ({ ...action, checked: value === mode })));
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
