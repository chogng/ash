import './media/callHierarchy.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AsyncDataTree } from '../../../../base/browser/ui/tree/asyncDataTree.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableMap } from '../../../../base/common/lifecycle.js';
import { type LanguageHierarchyItem } from '../../../../editor/common/languages.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { PeekViewWidget } from '../../../../editor/contrib/peekView/browser/peekView.js';
import { localize } from '../../../../nls.js';
import { CallHierarchyModel, CallHierarchyDirection } from '../common/callHierarchy.js';
import { Call, DataSource } from './callHierarchyTree.js';

export class CallHierarchyTreePeekWidget extends PeekViewWidget {
	private readonly selected = this._register(new Emitter<LanguageHierarchyItem>());
	public readonly onDidSelectItem = this.selected.event;
	private readonly rows = this._register(new DisposableMap<Call, Button>());
	private readonly tree: AsyncDataTree<CallHierarchyModel, Call>;
	private readonly buttons: readonly Button[];
	private model: CallHierarchyModel | undefined;
	private currentDirection = CallHierarchyDirection.CallsTo;

	public get direction(): CallHierarchyDirection { return this.currentDirection; }

	constructor(editor: ICodeEditor, onError: (error: unknown) => void) {
		super(editor);
		const body = h(this.element.ownerDocument, 'div');
		body.className = 'stanza-editor-language-hierarchy ash-call-hierarchy';
		const toolbar = h(body.ownerDocument, 'div');
		toolbar.className = 'ash-call-hierarchy-directions';
		const treeContainer = h(body.ownerDocument, 'div');
		treeContainer.className = 'ash-call-hierarchy-tree';
		body.append(toolbar, treeContainer);
		this.setBody(body);
		this.setTitle(localize('callHierarchy.title', 'Call Hierarchy'));
		const directions: readonly (readonly [CallHierarchyDirection, string])[] = [
			[CallHierarchyDirection.CallsTo, localize('hierarchy.callers', 'Callers')],
			[CallHierarchyDirection.CallsFrom, localize('hierarchy.callees', 'Callees')],
		];
		this.buttons = directions.map(([direction, label]) => {
			const button = this._register(new Button(toolbar, {
				label, checked: direction === this.currentDirection, presentation: 'quiet', size: 'small',
				onClick: () => { void this.expandDirection(direction).catch(onError); },
			}));
			button.domNode.classList.add('stanza-editor-language-hierarchy-expand');
			return button;
		});
		this.tree = this._register(new AsyncDataTree<CallHierarchyModel, Call>(treeContainer, new DataSource(() => this.direction), {
			ariaLabel: localize('callHierarchy.title', 'Call Hierarchy'),
			onDidRemoveRow: row => {
				for (const [node, button] of this.rows) {
					if (row.contains(button.domNode)) { this.rows.deleteAndDispose(node); }
				}
			},
			expandOnlyOnTwistieClick: true,
			collapseByDefault: () => true,
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: node => node.item.name },
			renderElement: node => {
				this.rows.deleteAndDispose(node);
				const button = new Button(treeContainer, {
					label: node.item.detail ? node.item.name + ' — ' + node.item.detail : node.item.name,
					title: node.item.resource.path, presentation: 'quiet', size: 'small',
					onClick: () => this.selected.fire(node.item),
				});
				this.rows.set(node, button);
				button.domNode.classList.add('stanza-editor-language-hierarchy-item');
				return button.domNode;
			},
		}));
		this._register(this.tree.onDidError(event => {
			if (!this.isDisposed) { onError(event.error); }
		}));
		this._register(this.tree.onDidAccept(event => this.selected.fire(event.element.item)));
	}

	public async showModel(model: CallHierarchyModel): Promise<void> {
		this.model = model;
		await this.tree.setInput(model);
		if (this.isDisposed) { return; }
		const first = this.tree.getVisibleElements()[0];
		if (first) { this.tree.setFocus(first); }
		this.buttons.forEach(button => button.domNode.setAttribute('aria-label',
			localize('hierarchy.directionFor', '{0} for {1}', button.label, model.roots[0]!.name)));
	}

	public async updateDirection(direction: CallHierarchyDirection): Promise<void> {
		this.currentDirection = direction;
		this.buttons[0]!.checked = direction === CallHierarchyDirection.CallsTo;
		this.buttons[1]!.checked = !this.buttons[0]!.checked;
		await this.tree.setInput(this.model);
	}

	private async expandDirection(direction: CallHierarchyDirection): Promise<void> {
		if (direction !== this.direction) { await this.updateDirection(direction); }
		const root = this.tree.getVisibleElements()[0];
		if (root) { this.tree.expand(root); }
	}
}
