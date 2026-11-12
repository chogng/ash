import './media/multiDiffEditorPane.css';
import { h } from '../../../../base/browser/dom.js';
import type { ObjectTreeElement } from '../../../../base/browser/ui/tree/objectTreeModel.js';
import { Disposable, DisposableMap, DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { posix } from '../../../../base/common/path.js';
import { ResourceTree, type IResourceNode } from '../../../../base/common/resourceTree.js';
import { dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { FileKind } from '../../../../platform/files/common/files.js';
import { WorkbenchObjectTree, type WorkbenchObjectTreeOptions } from '../../../../platform/list/browser/listService.js';
import { IResourceLabelService } from '../../../browser/labels.js';

export interface IMultiDiffEditorFileListItem {
	readonly type: 'file';
	readonly id: string;
	readonly path: string;
	readonly resource: URI;
	readonly label?: string;
}

interface IChangedFilesFolder {
	readonly type: 'folder';
	readonly id: string;
	readonly name: string;
	readonly resource?: URI;
}

type ChangedFilesElement<T extends IMultiDiffEditorFileListItem> = T | IChangedFilesFolder;

interface IChangedFilesGroup {
	readonly id: string;
	readonly label: string;
}

interface IChangedFilesListOptions<T extends IMultiDiffEditorFileListItem> extends Pick<WorkbenchObjectTreeOptions<T>, 'ariaLabel' | 'openOnSingleClick' | 'scrolling'> {
	readonly expandOnlyOnTwistieClick?: boolean;
	readonly group?: (file: T) => IChangedFilesGroup | undefined;
	readonly renderDetails?: (row: HTMLElement, file: T) => IDisposable | void;
}

function fileTree<T extends IMultiDiffEditorFileListItem>(files: readonly T[], groupFile?: (file: T) => IChangedFilesGroup | undefined): ObjectTreeElement<ChangedFilesElement<T>>[] {
	const root = URI.from({ scheme: 'ash-multi-diff-files', path: '/' });
	const groups = new Map<string, { group?: IChangedFilesGroup; folders: ResourceTree<T[], undefined>; }>();
	for (const file of files) {
		const group = groupFile?.(file);
		const key = group?.id ?? '';
		let entry = groups.get(key);
		if (!entry) {
			entry = { group, folders: new ResourceTree<T[], undefined>(undefined, root) };
			groups.set(key, entry);
		}
		const folder = dirname(root.with({ path: `/${file.path.replace(/^\/+/, '')}` }));
		const siblings = entry.folders.getNode(folder)?.element;
		if (siblings) siblings.push(file);
		else entry.folders.add(folder, [file]);
	}
	const children = (folder: IResourceNode<T[], undefined>, prefix: string): ObjectTreeElement<ChangedFilesElement<T>>[] => [
		...[...folder.children].sort((a, b) => a.name.localeCompare(b.name)).map(child => ({
			element: { type: 'folder' as const, id: `${prefix}${child.uri.path}`, name: child.name, resource: child.uri },
			children: children(child, prefix),
		})),
		...(folder.element ?? []).map(element => ({ element })),
	];
	return [...groups.values()].flatMap(({ group, folders }): ObjectTreeElement<ChangedFilesElement<T>>[] => group
		? [{ element: { type: 'folder', id: group.id, name: group.label }, children: children(folders.root, group.id) }]
		: children(folders.root, 'folder:'));
}

/** Renders a file inventory supplied by its editor or view, with optional groups and row details. */
export class MultiDiffEditorFileList<T extends IMultiDiffEditorFileListItem> extends Disposable {
	readonly tree: WorkbenchObjectTree<ChangedFilesElement<T>>;
	private mode: 'list' | 'tree' = 'list';

	constructor(
		container: HTMLElement,
		private readonly options: IChangedFilesListOptions<T>,
		@IConfigurationService configurationService: IConfigurationService,
		@IResourceLabelService resourceLabels: IResourceLabelService,
	) {
		super();
		const labels = this._register(resourceLabels.createGroup());
		const rows = this._register(new DisposableMap<HTMLElement, DisposableStore>());
		this.tree = this._register(new WorkbenchObjectTree<ChangedFilesElement<T>>(container, {
			configurationService,
			ariaLabel: options.ariaLabel,
			openOnSingleClick: options.openOnSingleClick,
			scrolling: options.scrolling,
			expandOnlyOnTwistieClick: options.expandOnlyOnTwistieClick,
			multipleSelectionSupport: true,
			modelOptions: { identityProvider: { getId: element => element.id }, defaultCollapseState: 'expanded' },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: element => element.type === 'file' ? element.label ?? element.path : element.name },
			renderElement: element => {
				const row = h(container.ownerDocument, 'div', { className: 'ash-multi-diff-file-list-row' });
				if (element.type === 'folder' && !element.resource) {
					row.textContent = element.name;
					return row;
				}
				const labelContainer = h(container.ownerDocument, 'span', { className: 'ash-multi-diff-file-list-label' });
				row.append(labelContainer);
				const lifetime = new DisposableStore();
				rows.set(row, lifetime);
				const label = lifetime.add(labels.create(labelContainer));
				if (element.type === 'file') {
					const directory = posix.dirname(element.path);
					label.setResource({
						resource: element.resource,
						name: posix.basename(element.path),
						description: this.mode === 'list' && directory !== '.' ? directory : undefined,
					}, {
						title: element.label ?? element.path,
						fileKind: FileKind.File,
					});
					const details = options.renderDetails?.(row, element);
					if (details) lifetime.add(details);
				} else {
					label.setResource({ resource: element.resource!, name: element.name }, { title: element.resource!.path.slice(1), fileKind: FileKind.Directory });
				}
				return row;
			},
			onDidRemoveRow: row => {
				const fileRow = row.querySelector<HTMLElement>('.ash-multi-diff-file-list-row');
				if (fileRow) rows.deleteAndDispose(fileRow);
			},
		}));
	}

	setFiles(files: readonly T[], mode: 'list' | 'tree'): void {
		this.mode = mode;
		this.tree.element.dataset.fileListMode = mode;
		this.tree.setChildren(mode === 'tree' ? fileTree(files, this.options.group) : files.map(element => ({ element })));
	}
}
