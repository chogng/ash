import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { localizedString } from '../../../../platform/action/common/action.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPanes } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewContainerLocation, type IView } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { DesignEditorPage } from './designEditorPage.js';
import { DesignEditorWidget } from './widget/designEditorWidget.js';
import { DESIGN_EDITOR_RESOURCE } from './designDocumentController.js';
import { DESIGN_LAYERS_CONTAINER_ID, DESIGN_PROPERTIES_CONTAINER_ID } from './designEditorService.js';
import { DesignLayersView, DesignPropertiesView } from './designViews.js';
import { designToolActions, designModeActions } from './widget/designToolsWidget.js';

EditorPanes.registerStatic({
	id: DesignEditorPage.ID,
	name: 'Design',
	canOpen: input => input.resource.toString() === DESIGN_EDITOR_RESOURCE.toString() ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Design editor requires an instantiation service');
		return options.instantiationService.createInstance(DesignEditorPage);
	},
});

// Tool commands receive the originating pane so dropdown focus cannot redirect them to another tab.
for (const [tool, key, title, icon] of designToolActions) {
	registerAction2(class SelectDesignTool extends Action2 {
		constructor() { super({ id: `sessions.design.tool.${tool}`, title: localizedString('ash', key, title), icon }); }
		public override run(_accessor: ServicesAccessor, editor: DesignEditorWidget): void { editor.setTool(tool); }
	});
}

for (const [mode, key, title, icon] of designModeActions) {
	registerAction2(class SwitchDesignMode extends Action2 {
		constructor() { super({ id: `sessions.design.mode.${mode}`, title: localizedString('ash', key, title), icon }); }
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
			() => localize('sessions.design.toolsHelp', 'The floating toolbar at the bottom of the canvas selects tools and modes. Use arrow keys within each toolbar. Selection tools groups Select and Move canvas; Shape tools groups Rectangle and Ellipse. Each group remembers its last tool. Use the dropdown arrow or Up/Down to open its menu; Escape returns focus to the trigger. Select chooses objects; Move canvas pans without moving objects. The four mode icons switch the current design tab. Hold Ctrl and scroll, or use Plus and Minus, to zoom. Select Rectangle or Ellipse and drag to draw. Select Text and click to place text. In Design mode, Pen places anchors; drag an anchor to create curve handles and press Enter to finish. In Draw mode, Pen draws a freehand stroke. Escape cancels the current drawing. Motion opens an animation timeline: select an object, Add keyframe creates start and end frames, select a keyframe and edit its position, rotation or opacity. Scrub Animation time to add intermediate frames. Duration and Loop apply to the object. Play previews the document with linear interpolation. Animated groups must have their own animation removed before ungrouping. Code shows generated HTML/CSS/SVG, CSS keyframes and editable JSON with object IDs. Export code saves a runnable HTML file; it does not mark the design as saved.') + '\n\n' + localize('sessions.design.contextMenuHelp', 'Right-click the canvas, or press Shift+F10 or the Menu key while the canvas is focused, to open editing, path node, export and open actions. Escape closes the menu and returns focus to the canvas.') + '\n\n' + localize('sessions.design.help', 'Design canvas\nOne design unit equals one pixel; grid lines are 12 units apart. Press R to add a rectangle or E to add an ellipse at the viewport center. Click a shape to select it, then drag or use arrow keys to move it; hold Shift for 10-pixel keyboard steps. Use Tab and Shift+Tab on the canvas to select shapes in paint order. Edit position, size, rotation and fill in Shape properties. Press Delete to remove the selection and Escape to cancel a drag or clear selection. <keybinding:sessions.design.undo> undoes an edit; <keybinding:sessions.design.redo> redoes it. Drag empty space or use the middle mouse button to pan. Arrow keys pan when no shape is selected. Hold Ctrl and scroll, or press Plus or Minus, to zoom. Press 0 to reset the view. <keybinding:sessions.design.save> writes an editable Ash design file; Open design loads one. Sessions Settings > Design lets you choose a pointer or hand cursor. Press T to add text and edit its content and font size in Shape properties. Press P to add a Bézier path; drag its anchors and handles, or edit anchors and incoming/outgoing handles in path-local pixels, choose a node, add or remove nodes, and toggle Closed path. Shift-click toggles objects in the selection; N adds the next unselected object, and Select all selects every object. Press G to group the selection and U to ungroup. Groups move and rotate together and resize proportionally. Export SVG saves the artwork without the grid or selection; it keeps unsaved edits in the editable design.'),
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

registerAction2(class UndoDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.undo', title: localizedString('ash', 'sessions.design.undo', 'Undo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.undo();
	}
});

registerAction2(class RedoDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.redo', title: localizedString('ash', 'sessions.design.redo', 'Redo'), keybinding: { primary: Keybinding.single(logicalKey('z', { primaryKey: true, shiftKey: true })), secondary: [Keybinding.single(logicalKey('y', { primaryKey: true }))], when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.redo();
	}
});

// The shared text editor registers Select All globally; the focused canvas must resolve first.
registerAction2(class SelectAllDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.selectAll', title: localizedString('ash', 'sessions.design.selectAll', 'Select all'), keybinding: { primary: Keybinding.single(logicalKey('a', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override run(accessor: ServicesAccessor): void {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		DesignEditorWidget.getFocused(focused)?.selectAll();
	}
});

registerAction2(class SaveDesign extends Action2 {
	constructor() {
		super({ id: 'sessions.design.save', title: localizedString('ash', 'sessions.design.save', 'Save design'), keybinding: { primary: Keybinding.single(logicalKey('s', { primaryKey: true })), when: ContextKeyExpr.has('sessionsDesignCanvasActive'), priority: 1000 } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
		await DesignEditorWidget.getFocused(focused)?.saveDocument();
	}
});
