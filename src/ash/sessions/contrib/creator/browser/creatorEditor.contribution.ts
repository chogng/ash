import { localize2, localize } from '../../../../nls.js';
import { Keybinding, logicalKey, physicalKey } from '../../../../base/common/keybindings.js';
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
import { IDesignEditorService, DESIGN_LAYERS_CONTAINER_ID, DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { DesignLayersView, DesignPropertiesView } from './designViews.js';
import { designToolActions, designModeActions } from './widget/designToolsWidget.js';
import { ColorPicker } from '../../../../base/browser/ui/colorPicker/colorPicker.js';
import { CreatorPage } from './creatorPage.js';

function effectHelp(): string { return localize('sessions.design.effectsHelp', 'Effects lists shadows and blurs from top to bottom. Use Tab to reach the effect list, then arrow keys to select an effect. Add, duplicate, reorder, hide or remove effects. Each layer supports eight drop shadows, eight inner shadows, one layer blur and one background blur. Shadow settings include X, Y, blur, color and blend mode. Spread is available on rectangles, ellipses and clipped frames with a visible fill. Show shadow behind transparent areas controls the drop-shadow cutout. Layer blur softens the layer and its effects; background blur softens content behind the layer and is visible through transparent fills. Effect styles preserve the entire stack. Changes support undo and redo. Layer and background blur support uniform and progressive modes. Progressive blur has separate start and end radii and positions, including positions outside the layer. Use the percentage fields or Edit blur on canvas. Drag either endpoint; Shift snaps the direction to 45 degrees. Drag the line to move both endpoints. On the canvas, Enter switches endpoints, arrow keys move one pixel, and Shift+arrow keys move ten pixels. Escape cancels an active drag and exits blur editing.'); }
function paintHelp(): string { return localize('sessions.design.paintHelp', 'Appearance lists fills from top to bottom. Add, duplicate, remove, move or hide fills independently. Each fill has its own opacity and blend mode; the Fill color button edits the selected solid paint or gradient stop. Gradients can be linear, radial, angular or diamond. Select a stop to edit its color and position, add or remove stops, or reverse their order. At least two stops remain. On the canvas, drag the origin to move the gradient, or its end and axis handles to change direction and range; Shift snaps direction to 15 degrees. Click the gradient axis to insert a stop, and drag a stop to change position; Control disables percentage snapping. Arrow keys move the active stop by 1%, or 10% with Shift; Delete removes it, and Escape leaves gradient editing. Pass through allows internal blend modes to affect content outside the layer; Normal isolates internal blending. Saving, undo and export preserve paint stacks and blend modes.'); }

function vectorNetworkHelp(): string { return localize('sessions.design.vectorAppearanceHelp', 'Node corner radius applies to the selected anchors in vector edit mode, or all anchors outside it. Radius is measured in pixels; endpoints use stroke caps. Variable width tool: click a path to add a width point, drag its side handles to change width, and drag its center along the path. Shift-click selects multiple width points; Delete removes them. Control disables snapping. Width profile, Width point position and Width at point provide keyboard access. Variable width is unavailable on branching networks or dashed strokes. Offset vector previews positive expansion or negative contraction with Square or Round joins. Apply offset or Enter confirms one undo step; Cancel offset or Escape restores the original. Corner smoothing applies to the entire layer, from 0 to 100%, with a 60% iOS preset; limited space reduces smoothing first. Stroke alignment can be inside, center or outside; open subpaths stay centered. Start and end can have independent arrows. In vector edit mode, Endpoint style changes only selected open endpoints; junctions have no arrow. Applying a width profile removes arrows and centers the stroke; setting an endpoint style restores uniform width.') + '\n\n' + localize('sessions.design.networkHelp', 'Vector networks: enter vector editing, press P, click any anchor and draw a branch. Click another anchor to connect; click a segment to insert a shared node. Drag when placing a node to bend the new segment. Enter or Escape finishes the current branch. V returns to node selection. Shared nodes move all incident segments; Shift-click selects several nodes and Connect selected nodes joins them. Shift+B or Paint regions enables click-to-paint; Alt-click also toggles region fill. Each region can have its own color. Network segment and Fill region controls provide keyboard access to handles, splitting, deletion and paint. Flatten selection (Alt+Shift+F) turns text into a single editable vector layer. Outline stroke (Ctrl or Command+Alt+O) gives each glyph its own vector layer. Both preserve placement, and Undo restores the text. Allow local font access or use Load font for outlines to supply a matching font file.') + '\n\n' + localize('sessions.design.vectorTopologyHelp', 'Intersection nodes: choose Add intersection nodes to connect crossings, tangencies and overlapping segment endpoints, or use Pen to click a crossing. Merge selected nodes combines anchors at their average position. Drag one anchor onto another to merge there; hold Alt to keep them separate. Simplify vector opens a preview with a strength slider and point count. Apply simplification commits one undo step; Cancel or Escape restores the original. Shift+Delete deletes and heals selected degree-two nodes while retaining endpoints and branch junctions.'); }
function textHelp(): string { return localize('sessions.design.textEditingHelp', "Press T, then click for auto-width text or drag a fixed-size box. Double-click text, or select its layer and press Enter or F2 to edit. Enter starts a paragraph; Escape or Ctrl/Command+Enter finishes. Select characters to format them in Typography; a caret sets the style for new text. Ctrl/Command+B, I, U toggle bold, italic, underline; A selects all. Typing, paste, formatting and IME use document undo. Auto width grows without wrapping; auto height wraps at the box width; fixed size keeps both dimensions. Typography controls alignment and px or percent spacing. Type details controls paragraphs, lists, decoration, case, wrapping, trim, OpenType features and variable font axes. Font features depend on the installed font. Truncation preserves content; Max lines clears Max height. Selection styles link to local or library styles."); }

function designLayoutHelp(): string {
	return localize('sessions.design.layoutHelp', 'Layer name renames the selected layer. Arrange duplicates and reorders layers, aligns sibling objects or one object inside its frame, and distributes spacing for three or more siblings. Ctrl or Command+D duplicates; Ctrl or Command+brackets changes stacking order, with Shift to move to the front or back. Shift+A adds auto layout to a frame or wraps sibling selections in a frame. Auto layout arranges children horizontally or vertically with gap, padding and alignment. Frames can hug contents or keep a fixed size; children can fill available space. Choosing Fill container makes that parent dimension fixed; choosing Hug contents makes child sizing fixed on that axis. Width or height edits switch that dimension to fixed. Constraints control child position and size when a free-layout frame resizes. Groups retain proportional sizing and support positional constraints. Use the layer tree to select nested frame children and its keyboard context menu to edit layers. All layout and layer edits can be undone.') + '\n\n' + localize('sessions.design.responsiveLayoutHelp', 'Wrap moves horizontal items into new rows, or vertical items into new columns, when the available space runs out. Line gap controls the space between those lines. Grid uses columns and rows with fixed, hug or fractional fill tracks; clear Rows for automatic rows. Column pixels / fraction and Row pixels / fraction set pixels for fixed tracks or relative shares for fill tracks. Automatic positioning follows layer order; manual positioning preserves empty cells. Grid children can span cells and align inside them. Size limits apply alongside fixed, hug and fill sizing; clear a limit to remove it. Minimum must not exceed maximum. All these controls are keyboard accessible and edits share the same undo history.') + '\n\n' + localize('sessions.design.componentsHelp', 'Components reuse a main component through linked instances. Click to select the component or instance; Ctrl-click or Command-click selects an inner layer. <keybinding:sessions.design.createComponent> creates a component; duplicating a main creates an instance. Components in Shape properties can insert local instances, combine main components as variants, add variants and edit named variant properties. Instance property menus switch variants or swap components while preserving overrides on matching layers. Main edits update instances; instances can override content, appearance and size but cannot add, delete or reorder inherited layers. Reset all overrides or Reset property restores inherited values. Push overrides to main updates the local main and other instances. Go to main component selects the source. Restore main component recovers a deleted source from its instance. <keybinding:sessions.design.detachInstance> detaches the selected instance into a regular frame while preserving nested instance links. Component operations, overrides and variant changes are saved in the design document and can be undone.') + '\n\n' + localize('sessions.design.resourcesHelp', 'Design resources contains Bindings and modes, Variables, Styles and Libraries. Use Tab to reach each section and Enter or Space to expand it. Variables support color, number, string and boolean values, collections, named modes and same-type aliases. Bind property links a selected layer property; Literal value detaches it. Auto inherits the parent mode or the collection default; with no selection, mode changes apply to the page. Create styles from the selection, apply them to layers, or update their definition from a selection. Direct property edits detach the affected binding or style. Layout guides are editing aids and are excluded from artwork exports. Publish library writes a portable library file containing components, styles, variables and image data. Add library enables its published resources. Check updates shows added, changed and removed definitions; expand each change to read its previous and new values. Accept update applies that version while preserving instance overrides. Disabling a library hides it from pickers and keeps existing references. Local resource edits and accepting library updates can be undone.');
}

for (const [tool, title, icon] of designToolActions) {
	registerAction2(class SelectDesignTool extends Action2 {
		constructor() { super({ id: `sessions.design.tool.${tool}`, title: title(), icon }); }
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

for (const [mode, title, icon] of designModeActions) {
	registerAction2(class SwitchDesignMode extends Action2 {
		constructor() { super({ id: `sessions.design.mode.${mode}`, title: title(), icon }); }
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
	when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasFocused'), ContextKeyExpr.has('sessionsDesignLayersFocused')),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.DesignCanvas,
			{ type: AccessibleViewType.Help },
			() => textHelp() + '\n\n' + paintHelp() + '\n\n' + effectHelp() + '\n\n' + vectorNetworkHelp() + '\n\n' + localize('sessions.design.vectorHelp', 'Vector editing: press P for Pen. Click to place corners, drag for curves, click the first anchor to close, and press Enter or Escape to finish. Shift constrains angles; Alt moves a handle independently. Enter or double-click a path enters node editing. Shift-click or drag a box to select nodes, use arrow keys to nudge, and Delete to remove nodes. With Pen, click a segment to insert a node without changing its curve. Vector tools provide handle mirroring, corners, smooth points, cut, reverse, join, stroke caps, joins and dashes. Alt+Shift+U/S/I/E combines selected layers using union, subtract, intersect or exclude. Original layers remain editable; Ungroup restores them. Ctrl or Command+E flattens geometry; add Shift to outline a stroke. Escape leaves node editing.') + '\n\n' + prototypeHelp() + '\n\n' + designLayoutHelp() + '\n\n' + (CreatorPage.getFocused(focused)?.getAccessibleContent() ?? '') + '\n\n' + localize('sessions.design.mediaHelp', 'Press F or choose Add frame to create a fixed-size artboard. Resizing a free-layout frame applies child constraints; the default keeps child geometry. Import image (I) places a PNG, JPEG or WebP image in the selected frame or at the viewport center. Drawn objects inside a frame use frame-local coordinates. Select frame contents in Layers, or click them on the canvas. Change Crop left, top, width and height percentages in Shape properties; the original image stays intact. Clip contents controls the frame boundary. Duplicate creates independent objects and reuses saved image versions. Save writes a design package with manifest.json and original images; Open design accepts a package or a version 1 JSON file. Export embeds images so SVG and HTML work outside Ash.') + '\n\n' + localize('sessions.design.toolsHelp', 'The floating toolbar at the bottom of the canvas selects tools and modes. Use arrow keys within each toolbar. Selection tools groups Select and Move canvas; Shape tools groups Rectangle and Ellipse. Each group remembers its last tool. Use the dropdown arrow or Up/Down to open its menu; Escape returns focus to the trigger. Select chooses objects; Move canvas pans without moving objects. The four mode icons switch the current design tab. Hold Ctrl and scroll, or use Plus and Minus, to zoom. Select Rectangle or Ellipse and drag to draw. Select Text and click to place text. In Design mode, Pen places anchors; drag an anchor to create curve handles and press Enter to finish. In Draw mode, Pen draws a freehand stroke. Escape finishes a pen path or cancels another drawing. Motion opens an animation timeline: select an object, Add keyframe creates start and end frames, select a keyframe and edit its position, rotation or opacity. Scrub Animation time to add intermediate frames. Duration and Loop apply to the object. Play previews the document with linear interpolation. Animated groups must have their own animation removed before ungrouping. Code shows generated HTML/CSS/SVG, CSS keyframes and editable JSON with object IDs. Export code saves a runnable HTML file; it does not mark the design as saved.') + '\n\n' + localize('sessions.design.contextMenuHelp', 'Right-click the canvas, or press Shift+F10 or the Menu key while the canvas is focused, to open editing, path node, export and open actions. Escape closes the menu and returns focus to the canvas.') + '\n\n' + localize('sessions.design.help', 'Design canvas\nOne design unit equals one pixel; grid lines are 12 units apart. Press R to add a rectangle or E to add an ellipse at the viewport center. Click a shape to select it, then drag or use arrow keys to move it; hold Shift for 10-pixel keyboard steps. Use Tab and Shift+Tab on the canvas to select shapes in paint order. Edit position, size, rotation and fill in Shape properties. Press Delete to remove the selection and Escape to cancel a drag or clear selection. <keybinding:sessions.design.undo> undoes an edit; <keybinding:sessions.design.redo> redoes it. Drag empty space or use the middle mouse button to pan. Arrow keys pan when no shape is selected. Hold Ctrl and scroll, or press Plus or Minus, to zoom. Press 0 to reset the view. <keybinding:sessions.design.save> writes an editable Ash design file; Open design loads one. Sessions Settings > Design lets you choose a pointer or hand cursor. Press T to choose the text tool; click or drag on the canvas to create text. Press P to draw a Bézier path; drag its anchors and handles, or edit anchors and incoming/outgoing handles in path-local pixels, choose a node, add or remove nodes, and toggle Closed path. Shift-click toggles objects in the selection; N adds the next unselected object, and Select all selects every object. Press G to group the selection and U to ungroup. Groups move and rotate together and resize proportionally. Export SVG saves the artwork without the grid or selection; it keeps unsaved edits in the editable design.'),
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
			() => textHelp() + '\n\n' + paintHelp() + '\n\n' + effectHelp() + '\n\n' + vectorNetworkHelp() + '\n\n' + localize('sessions.design.vectorHelp', 'Vector editing: press P for Pen. Click to place corners, drag for curves, click the first anchor to close, and press Enter or Escape to finish. Shift constrains angles; Alt moves a handle independently. Enter or double-click a path enters node editing. Shift-click or drag a box to select nodes, use arrow keys to nudge, and Delete to remove nodes. With Pen, click a segment to insert a node without changing its curve. Vector tools provide handle mirroring, corners, smooth points, cut, reverse, join, stroke caps, joins and dashes. Alt+Shift+U/S/I/E combines selected layers using union, subtract, intersect or exclude. Original layers remain editable; Ungroup restores them. Ctrl or Command+E flattens geometry; add Shift to outline a stroke. Escape leaves node editing.') + '\n\n' + prototypeHelp() + '\n\n' + designLayoutHelp() + '\n\n' + localize('sessions.design.propertiesHelp', 'With no selection, Page shows the design name and object count. Layout guide describes the canvas grid; Export saves the whole design as SVG or HTML. With one object selected, properties are grouped into collapsible sections. Use Tab to move between section headings and fields; press Enter or Space on a section heading to collapse or expand it. Position edits X, Y and rotation; Layout edits width, height and frame clipping. Appearance edits fill opacity and opens the color picker with Hex, RGB, CSS, HSL, HSB and opacity controls. Press Alt+F1 inside the color picker for keyboard help. Typography, Bézier path and Image crop show controls for the selected object type. Stroke width changes the selected path. Each committed change uses the design document undo history.'),
			() => focused.focus(),
			AccessibilityVerbositySettingId.DesignCanvas,
		);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View,
	priority: 100,
	name: 'sessionsDesignCanvasContent',
	when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasFocused'), ContextKeyExpr.has('sessionsDesignLayersFocused')),
	getProvider: accessor => {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		const editor = DesignEditorWidget.getFocused(focused) ?? (focused.closest('.ash-design-layers') ? accessor.get(IDesignEditorService).activeEditor.get() : undefined);
		const content = editor?.getAccessibleContent();
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
		super({ id: 'sessions.design.undo', title: localize2({ bundle: 'ash', key: 'sessions.design.undo' }, 'Undo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true })), when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasActive'), ContextKeyExpr.has('sessionsDesignTextEditing')), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.undo();
	}
});

registerAction2(class RedoDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.redo', title: localize2({ bundle: 'ash', key: 'sessions.design.redo' }, 'Redo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true, shiftKey: true })), secondary: [Keybinding.single(logicalKey('y', { primaryKey: true }))], when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasActive'), ContextKeyExpr.has('sessionsDesignTextEditing')), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.redo();
	}
});

// The shared text editor registers Select All globally; the focused canvas must resolve first.
registerAction2(class SelectAllDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.selectAll', title: localize2({ bundle: 'ash', key: 'sessions.design.selectAll' }, 'Select all'), keybinding: { primary: Keybinding.single(logicalKey('a', { primaryKey: true })), when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasActive'), ContextKeyExpr.has('sessionsDesignTextEditing')), priority: 1000 } });
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

// These chords also exist in text editors; resolve them in the owning design context first.
for (const [id, key, title, chord, run] of [
	['duplicate', 'sessions.design.duplicate', 'Duplicate', logicalKey('d', { primaryKey: true }), (editor: DesignEditorWidget) => editor.duplicateSelected()],
	['bringForward', 'sessions.design.bringForward', 'Bring forward', physicalKey('BracketRight', { primaryKey: true }), (editor: DesignEditorWidget) => editor.reorderSelected('forward')],
	['sendBackward', 'sessions.design.sendBackward', 'Send backward', physicalKey('BracketLeft', { primaryKey: true }), (editor: DesignEditorWidget) => editor.reorderSelected('backward')],
	['bringToFront', 'sessions.design.bringToFront', 'Bring to front', physicalKey('BracketRight', { primaryKey: true, shiftKey: true }), (editor: DesignEditorWidget) => editor.reorderSelected('front')],
	['sendToBack', 'sessions.design.sendToBack', 'Send to back', physicalKey('BracketLeft', { primaryKey: true, shiftKey: true }), (editor: DesignEditorWidget) => editor.reorderSelected('back')],
	['addAutoLayout', 'sessions.design.addAutoLayout', 'Add auto layout', logicalKey('a', { shiftKey: true }), (editor: DesignEditorWidget) => editor.addAutoLayout()],
	['createComponent', 'sessions.design.createComponent', 'Create component', physicalKey('KeyK', { primaryKey: true, altKey: true }), (editor: DesignEditorWidget) => editor.createComponent()],
	['detachInstance', 'sessions.design.detachInstance', 'Detach instance', physicalKey('KeyB', { primaryKey: true, altKey: true }), (editor: DesignEditorWidget) => editor.detachInstance()],
] as const) {
	registerAction2(class EditDesignLayout extends Action2 {
		constructor() {
			super({ id: `sessions.design.${id}`, title: localize2({ bundle: 'ash', key }, title), keybinding: { primary: Keybinding.single(chord), when: ContextKeyExpr.or(ContextKeyExpr.has('sessionsDesignCanvasActive'), ContextKeyExpr.has('sessionsDesignLayersFocused')), priority: 1000 } });
		}
		public override run(accessor: ServicesAccessor): void {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const editor = DesignEditorWidget.getFocused(focused) ?? (focused.closest('.ash-design-layers') ? accessor.get(IDesignEditorService).activeEditor.get() : undefined);
			if (editor) { run(editor); }
		}
	});
}

function prototypeHelp(): string {
	return localize('sessions.design.prototype.scrollHelp', 'Overflow scrolling supports horizontal, vertical and nested frames. Preview scrolls with the wheel or a drag; explicit On drag interactions take priority. Focus a scrolling region and use arrow keys, Page Up, Page Down, Home or End. Scroll to targets layers in the same screen with an instant or animated transition. Fixed layers stay above scrolling content; in Auto Layout, first enable Ignore auto layout. Sticky layers stop at the top and remain within their direct parent. Scroll positions are remembered when navigating; Reset scroll position clears the destination and its nested frames. Restart flow clears all scroll positions.') + '\n\n' + localize('sessions.design.prototype.help', 'Prototype properties add interactions to layers. Choose a trigger, action, destination, transition, easing and duration. Drag a connection handle to a top-level screen, or use Destination with the keyboard. Flow starting points define named journeys. Prototype preview follows hotspots instead of screen order. Tab focuses hotspots; Enter or Space activates them. Back follows navigation history. Change to switches the triggered instance to a variant in the same component set, preserving its overrides. Escape closes the top overlay, then returns to editing. While hovering and While pressing revert when released. Smart animate matches layer names and hierarchy; unmatched layers dissolve. Reduced motion uses instant transitions. Playback never changes the saved document. Add action creates an ordered chain; Move action up and Move action down reorder it. Set variable accepts arithmetic, comparisons, and, or, not, quoted text, and parentheses. Insert variable adds a stable variable reference; press Enter to apply an expression. Conditional runs the first matching If or Else if branch, otherwise Else. Later actions read earlier writes, and animations run in sequence. Custom spring exposes mass, stiffness, damping and initial velocity with a curve preview and automatic settling duration. Restart flow resets runtime variables and modes.');
}

for (const [format, key, title] of [
	['bold', 'b', localize2('sessions.design.textBold', 'Bold')],
	['italic', 'i', localize2('sessions.design.textItalic', 'Italic')],
	['underline', 'u', localize2('sessions.design.textUnderline', 'Underline')],
] as const) {
	registerAction2(class extends Action2 {
		constructor() { super({ id: `sessions.design.text.${format}`, title, keybinding: { primary: Keybinding.single(logicalKey(key, { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignTextEditing'), priority: 1000 } }); }
		public override run(accessor: ServicesAccessor): void {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			DesignEditorWidget.getFocused(focused)?.formatText(format);
		}
	});
}
