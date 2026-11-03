import './media/chatTreeContentPart.css';
import { addDisposableListener, getWindow, h } from '../../../../../../base/browser/dom.js';
import { ObjectTree } from '../../../../../../base/browser/ui/tree/objectTree.js';
import type { ObjectTreeElement } from '../../../../../../base/browser/ui/tree/objectTreeModel.js';
import { Emitter } from '../../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { FileKind } from '../../../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { defaultListStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import type { IChatResponseProgressFileTreeData, IChatTreeData } from '../../../common/chatService/chatService.js';

/** Displays the original result snapshot. Expanding a directory never fetches new contents. */
export class ChatTreeContentPart extends Disposable {
	readonly domNode: HTMLElement;
	private readonly tree: ObjectTree<IChatResponseProgressFileTreeData>;
	private readonly focused = this._register(new Emitter<void>());
	readonly onDidFocus = this.focused.event;
	private readonly heightChanged = this._register(new Emitter<void>());
	readonly onDidChangeHeight = this.heightChanged.event;
	readonly treeDataId: string;

	constructor(document: Document, data: IChatTreeData,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.treeDataId = data.treeData.uri.toString();
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-chat-file-tree';
		this.tree = this._register(new ObjectTree(this.domNode, {
			styles: defaultListStyles,
			ariaLabel: localize('chat.fileTree.label', 'File tree: {0}', data.treeData.label),
			modelOptions: { identityProvider: { getId: entry => entry.uri.toString() } },
			accessibilityProvider: { getAriaLabel: entry => entry.label },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: entry => entry.label },
			renderElement: entry => {
				const label = h(document, 'span');
				label.className = 'ash-chat-file-tree-label';
				label.textContent = entry.label;
				label.title = entry.uri.toString();
				return label;
			},
		}));
		const node = (entry: IChatResponseProgressFileTreeData): ObjectTreeElement<IChatResponseProgressFileTreeData> => ({
			element: entry, children: entry.children?.map(node), collapsed: false,
		});
		this.tree.model.setChildren([node(data.treeData)]);
		this._register(this.tree.onDidAccept(event => this.open(event.element)));
		this._register(this.tree.onDidDoubleClick(event => this.open(event.element)));
		this._register(this.tree.onDidChangeCollapseState(() => { this.layout(this.domNode.clientWidth); this.heightChanged.fire(); }));
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.focused.fire()));
		this._register(toDisposable(() => this.domNode.remove()));
		const observer = new (getWindow(this.domNode).ResizeObserver)(() => this.layout(this.domNode.clientWidth));
		observer.observe(this.domNode);
		this._register(toDisposable(() => observer.disconnect()));
		this.layout(0);
	}

	private open(entry: IChatResponseProgressFileTreeData): void {
		if (entry.type === FileKind.Directory || entry.children) return;
		void this.editors.openEditor({ resource: entry.uri }, { pinned: true, ignoreError: true }).catch(error => {
			if (!this.isDisposed) this.notifications.error(localize('chat.fileTree.openFailed', 'Could not open {0}: {1}', entry.label, String(error)));
		});
	}

	layout(width: number): void {
		this.tree.layout(Math.min(264, Math.max(22, this.tree.getVisibleElements().length * 22)), width || undefined);
	}

	focus(): void {
		// Tree navigation is an explicit reveal of the captured result, including its tool disclosure.
		for (let parent = this.domNode.parentElement; parent; parent = parent.parentElement) {
			if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true;
		}
		this.domNode.scrollIntoView({ block: 'nearest' });
		this.layout(this.domNode.clientWidth);
		if (!this.tree.focus) this.tree.setFocus(this.treeDataId);
		this.tree.domFocus();
	}
}
