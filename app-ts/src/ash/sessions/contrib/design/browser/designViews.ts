import './designViews.css';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { h } from '../../../../base/browser/dom.js';
import { autorunWithStore } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { WorkbenchObjectTree } from '../../../../platform/list/browser/listService.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { DesignShape } from '../common/model/document.js';
import { IDesignEditorService } from './designEditorService.js';

interface DesignLayer { readonly element: DesignShape; readonly children?: readonly DesignLayer[]; }

function shapeLabel(shape: DesignShape): string {
	switch (shape.kind) {
		case 'rectangle': return localize('sessions.design.rectangle', 'Rectangle');
		case 'ellipse': return localize('sessions.design.ellipse', 'Ellipse');
		case 'text': return shape.text || localize('sessions.design.text', 'Text');
		case 'path': return localize('sessions.design.path', 'Bézier path');
		case 'frame': return localize('sessions.design.frame', 'Frame');
		case 'image': return localize('sessions.design.image', 'Image');
		case 'group': return localize('sessions.design.group', 'Group');
	}
}

/** Paint-order navigation selects the same top-level objects as the canvas. */
export class DesignLayersView extends ViewPane {
	private readonly tree: WorkbenchObjectTree<DesignShape>;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IDesignEditorService editors: IDesignEditorService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super(container, options);
		this.contentElement.classList.add('ash-design-layers');
		const empty = h(container.ownerDocument, 'p', { className: 'ash-design-panel-message' });
		empty.textContent = localize('sessions.design.layersEmpty', 'Draw an object to add a layer.');
		const treeContainer = h(container.ownerDocument, 'div', { className: 'ash-design-layers-tree' });
		this.contentElement.append(empty, treeContainer);
		this.tree = this._register(new WorkbenchObjectTree(treeContainer, {
			configurationService: configuration,
			ariaLabel: localize('sessions.design.layers', 'Layers'),
			multipleSelectionSupport: true,
			modelOptions: { identityProvider: { getId: shape => shape.id } },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: shapeLabel },
			renderElement: shape => h(container.ownerDocument, 'span', { className: 'ash-design-layer-label' }, shapeLabel(shape)),
		}));
		this._register(this.tree.onDidChangeSelection(event => {
			if (event.browserEvent) editors.activeEditor.get()?.selectShapes(event.elements.map(shape => shape.id));
		}));
		this._register(autorunWithStore((reader, store) => {
			const editor = editors.activeEditor.read(reader);
			let renderedShapes: readonly DesignShape[] | undefined = [];
			const refresh = (): void => {
				const shapes = editor?.documentController.model.value.shapes;
				if (shapes !== renderedShapes) {
					renderedShapes = shapes;
					// Frontmost objects appear first, without changing the document's paint order.
					const layers = (items: readonly DesignShape[]): DesignLayer[] => [...items].reverse().map(element => ({ element, ...(element.kind === 'frame' ? { children: layers(element.children) } : {}) }));
					this.tree.setChildren(layers(shapes ?? []));
				}
				empty.hidden = !!shapes?.length;
				this.tree.setSelection([...(editor?.selection.ids ?? [])]);
			};
			if (editor) store.add(editor.onDidChangeView(refresh));
			refresh();
		}));
	}
	public focus(): void { this.tree.domFocus(); }
}

/** AuxiliaryBarPart hosts the editor-owned property component without copying its model. */
export class DesignPropertiesView extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions, @IDesignEditorService private readonly editors: IDesignEditorService, @IContextKeyService contextKeys: IContextKeyService) {
		super(container, options);
		this.contentElement.classList.add('ash-design-properties-view');
		this.contentElement.tabIndex = 0;
		this._register(contextKeys.createScoped(this.contentElement)).createKey('sessionsDesignPropertiesFocused', true);
		const empty = h(container.ownerDocument, 'p', { className: 'ash-design-panel-message' });
		empty.textContent = localize('sessions.design.propertiesEmpty', 'Select one object to edit its properties.');
		this.contentElement.append(empty);
		this._register(autorunWithStore((reader, store) => {
			const editor = editors.activeEditor.read(reader);
			if (!editor) { empty.hidden = false; return; }
			const properties = editor.propertiesDomNode;
			this.contentElement.append(properties);
			store.add(toDisposable(() => properties.remove()));
			const refresh = (): void => { empty.hidden = editor.hasEditableProperties; };
			store.add(editor.onDidChangeView(refresh));
			refresh();
		}));
	}
	public focus(): void {
		const editor = this.editors.activeEditor.get();
		if (editor?.hasEditableProperties && !editor.documentController.isBusy) editor.focusProperties();
		else this.contentElement.focus();
	}
}
