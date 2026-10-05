import { localize2, localize } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getActiveElement } from '../../../../base/browser/dom.js';

import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewContainerLocation, type IView } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { DesignEditorWidget } from './widget/designEditorWidget.js';
import { DESIGN_LAYERS_CONTAINER_ID, DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { DesignLayersView, DesignPropertiesView } from './designViews.js';
import { designToolActions, designModeActions } from './widget/designToolsWidget.js';
import { ColorPicker } from '../../../../base/browser/ui/colorPicker/colorPicker.js';
import { CreatorPage } from './creatorPage.js';

for (const [tool, key, title, icon] of designToolActions) {
	registerAction2(class SelectDesignTool extends Action2 {
		constructor() { super({ id: `sessions.design.tool.${tool}`, title: localize2({ bundle: 'ash', key: key }, title), icon }); }
		public override run(_accessor: ServicesAccessor, editor: DesignEditorWidget): void { editor.setTool(tool); }
	});
}

for (const [id, key, title] of [['addFrame', 'sessions.design.addFrame', 'Add frame (F)'], ['importImage', 'sessions.design.importImage', 'Import image']] as const) {
	registerAction2(class EditDesignMedia extends Action2 {
		constructor() { super({ id: `sessions.design.${id}`, title: localize2({ bundle: 'ash', key: key }, title) }); }
		public override async run(_accessor: ServicesAccessor, editor: DesignEditorWidget): Promise<void> {
			if (id === 'addFrame') { editor.addFrame(); }
			else { await editor.importImage(); }
		}
	});
}

for (const [mode, key, title, icon] of designModeActions) {
	registerAction2(class SwitchDesignMode extends Action2 {
		constructor() { super({ id: `sessions.design.mode.${mode}`, title: localize2({ bundle: 'ash', key: key }, title), icon }); }
		public override run(_accessor: ServicesAccessor, editor: DesignEditorWidget): void { editor.setMode(mode); }
	});
}

for (const [id, title, key, location, view] of [
	[DESIGN_LAYERS_CONTAINER_ID, 'Layers', 'sessions.design.layers', ViewContainerLocation.Sidebar, DesignLayersView],
	[DESIGN_PROPERTIES_CONTAINER_ID, 'Shape properties', 'sessions.design.properties', ViewContainerLocation.AuxiliaryBar, DesignPropertiesView],
] as const) {
	SessionsViewRegistry.registerStaticViewContainer({ id, title, localizationKey: { bundle: 'ash', key }, location, order: 2 });
	SessionsViewRegistry.registerStaticViews(id, [{ id: `${id}.view`, title, localizationKey: { bundle: 'ash', key }, ctorDescriptor: new SyncDescriptor<IView>(view), canToggleVisibility: false }]);
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DesignCanvas,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Design canvas accessibility verbosity must be boolean');
		}
		return value;
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'sessionsDesignCanvasHelp',
	when: ContextKeyExpr.has('sessionsDesignCanvasFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.Help },
			() => (CreatorPage.getFocused(focused)?.getAccessibleContent() ?? '') + '\n\n' + localize('sessions.design.mediaHelp', 'Press F or choose Add frame to create a fixed-size artboard. Resizing a frame keeps its child geometry. Import image (I) places a PNG, JPEG or WebP image in the selected frame or at the viewport center. Drawn objects inside a frame use frame-local coordinates. Select frame contents in Layers, or click them on the canvas. Change Crop left, top, width and height percentages in Shape properties; the original image stays intact. Clip contents controls the frame boundary. Duplicate image creates another use of the same saved image version. Save writes a design package with manifest.json and original images; Open design accepts a package or a version 1 JSON file. Export embeds images so SVG and HTML work outside Ash.') + '\n\n' + localize('sessions.design.toolsHelp', 'The floating toolbar at the bottom of the canvas selects tools and modes. Use arrow keys within each toolbar. Selection tools groups Select and Move canvas; Shape tools groups Rectangle and Ellipse. Each group remembers its last tool. Use the dropdown arrow or Up/Down to open its menu; Escape returns focus to the trigger. Select chooses objects; Move canvas pans without moving objects. The four mode icons switch the current design tab. Hold Ctrl and scroll, or use Plus and Minus, to zoom. Select Rectangle or Ellipse and drag to draw. Select Text and click to place text. In Design mode, Pen places anchors; drag an anchor to create curve handles and press Enter to finish. In Draw mode, Pen draws a freehand stroke. Escape cancels the current drawing. Motion opens an animation timeline: select an object, Add keyframe creates start and end frames, select a keyframe and edit its position, rotation or opacity. Scrub Animation time to add intermediate frames. Duration and Loop apply to the object. Play previews the document with linear interpolation. Animated groups must have their own animation removed before ungrouping. Code shows generated HTML/CSS/SVG, CSS keyframes and editable JSON with object IDs. Export code saves a runnable HTML file; it does not mark the design as saved.') + '\n\n' + localize('sessions.design.contextMenuHelp', 'Right-click the canvas, or press Shift+F10 or the Menu key while the canvas is focused, to open editing, path node, export and open actions. Escape closes the menu and returns focus to the canvas.') + '\n\n' + localize('sessions.design.help', 'Design canvas\nOne design unit equals one pixel; grid lines are 12 units apart. Press R to add a rectangle or E to add an ellipse at the viewport center. Click a shape to select it, then drag or use arrow keys to move it; hold Shift for 10-pixel keyboard steps. Use Tab and Shift+Tab on the canvas to select shapes in paint order. Edit position, size, rotation and fill in Shape properties. Press Delete to remove the selection and Escape to cancel a drag or clear selection. <keybinding:sessions.design.undo> undoes an edit; <keybinding:sessions.design.redo> redoes it. Drag empty space or use the middle mouse button to pan. Arrow keys pan when no shape is selected. Hold Ctrl and scroll, or press Plus or Minus, to zoom. Press 0 to reset the view. <keybinding:sessions.design.save> writes an editable Ash design file; Open design loads one. Sessions Settings > Design lets you choose a pointer or hand cursor. Press T to add text and edit its content and font size in Shape properties. Press P to add a Bézier path; drag its anchors and handles, or edit anchors and incoming/outgoing handles in path-local pixels, choose a node, add or remove nodes, and toggle Closed path. Shift-click toggles objects in the selection; N adds the next unselected object, and Select all selects every object. Press G to group the selection and U to ungroup. Groups move and rotate together and resize proportionally. Export SVG saves the artwork without the grid or selection; it keeps unsaved edits in the editable design.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'sessionsDesignPropertiesHelp',
	when: ContextKeyExpr.has('sessionsDesignPropertiesFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.design.propertiesHelp', 'With no selection, Page shows the design name and object count. Layout guide describes the canvas grid; Export saves the whole design as SVG or HTML. With one object selected, properties are grouped into collapsible sections. Use Tab to move between section headings and fields; press Enter or Space on a section heading to collapse or expand it. Position edits X, Y and rotation; Layout edits width, height and frame clipping. Appearance edits fill opacity and opens the color picker with Hex, RGB, CSS, HSL, HSB and opacity controls. Press Alt+F1 inside the color picker for keyboard help. Typography, Bézier path and Image crop show controls for the selected object type. Stroke width changes the selected path. Each committed change uses the design document undo history.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'sessionsDesignCanvasContent',
	when: ContextKeyExpr.has('sessionsDesignCanvasFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		const content = DesignEditorWidget.getFocused(focused)?.getAccessibleContent();
		if (content === undefined) { return undefined; }
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.View },
			() => content,
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 110,
	name: 'sessionsDesignColorPickerHelp',
	when: ContextKeyExpr.has('sessionsDesignColorPickerFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.design.colorHelp', 'Color picker\nUse Left and Right to change saturation, Up and Down to change brightness. Hold Shift for larger steps. Tab moves through hue, opacity, format, color values and palettes. Choose Hex, RGB, CSS, HSL or HSB; HSB means hue, saturation and brightness. CSS accepts absolute CSS color values. Opacity ranges from 0 to 100%. Arrow keys navigate palette colors; Enter selects a color. Dragging previews the canvas and commits once when released. Escape discards an unfinished edit and returns focus to Fill. Close or clicking outside commits a valid edit. <keybinding:editor.action.accessibleView> reads the current color in all formats.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 110,
	name: 'sessionsDesignColorPickerContent',
	when: ContextKeyExpr.has('sessionsDesignColorPickerFocused'),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		const picker = ColorPicker.getFocused(focused);
		if (!picker) { return undefined; }
		return new AccessibleContentProvider(AccessibleViewProviderId.DesignCanvas, { type: AccessibleViewType.View }, () => picker.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.DesignCanvas);
	},
});

registerAction2(class UndoDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.undo', title: localize2({ bundle: 'ash', key: 'sessions.design.undo' }, 'Undo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.undo();
	}
});

registerAction2(class RedoDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.redo', title: localize2({ bundle: 'ash', key: 'sessions.design.redo' }, 'Redo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true, shiftKey: true })), secondary: [Keybinding.single(logicalKey('y', { primaryKey: true }))], when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.redo();
	}
});

// The shared text editor registers Select All globally; the focused canvas must resolve first.
registerAction2(class SelectAllDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.selectAll', title: localize2({ bundle: 'ash', key: 'sessions.design.selectAll' }, 'Select all'), keybinding: { primary: Keybinding.single(logicalKey('a', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.selectAll();
	}
});

registerAction2(class SaveDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.save', title: localize2({ bundle: 'ash', key: 'sessions.design.save' }, 'Save design'), keybinding: { primary: Keybinding.single(logicalKey('s', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		await DesignEditorWidget.getFocused(focused)?.saveDocument();
	}
});
