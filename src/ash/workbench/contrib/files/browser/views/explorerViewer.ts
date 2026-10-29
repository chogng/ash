import { isMacintosh } from '../../../../../base/common/platform.js';
import { compareFileNames, compareFileNamesUnicode } from '../../../../../base/common/comparers.js';
import { basename, dirname, extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import type { TreeDragAndDrop, TreeDragData, TreeDragOverReaction } from '../../../../../base/browser/ui/tree/tree.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import type { WorkbenchCompressibleAsyncDataTree } from '../../../../../platform/list/browser/listService.js';
import { addDisposableListener, h, stopEvent } from '../../../../../base/browser/dom.js';
import {
	AbstractDisposable,
	Disposable,
	DisposableMap,
	DisposableStore,
	toDisposable,
} from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import {
	FileKind,
	FileNotFoundError,
	FileSystemProviderCapabilities,
	IFileService,
} from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IDecorationsService } from '../../../../services/decorations/common/decorations.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels, IResourceIconRenderer } from '../../../../browser/labels.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { ExplorerFileNestingSettingId, ExplorerFileNestingTrie } from '../../common/explorerFileNestingTrie.js';
import { provideDecorations } from './explorerDecorationsProvider.js';
import { explorerFileContribRegistry } from '../explorerFileContrib.js';
import type { IExpression } from '../../../../../base/common/glob.js';
import { SortOrder, LexicographicOptions } from '../../common/files.js';
import { ResourceGlobMatcher } from '../../../../common/resources.js';

/** Finds workspace names using the tree's cache without changing folder expansion. */
export class ExplorerFindProvider extends Disposable {
	private readonly input: HTMLInputElement;
	private searchGeneration = 0;
	private readonly search = this._register(
		new RunOnceScheduler(() => {
			void this.findWorkspaceNames();
		}, 150),
	);

	constructor(
		private readonly tree: WorkbenchCompressibleAsyncDataTree<ExplorerItem, ExplorerItem>,
		host: HTMLElement,
	) {
		super();
		this.input = h(host.ownerDocument, 'input');
		this.input.type = 'search';
		this.input.className = 'ash-explorer-find-input';
		const updateLabel = () => {
			const label = localize('files.findInExplorer', 'Find files in Explorer');
			this.input.setAttribute('aria-label', label);
			this.input.placeholder = label;
		};
		updateLabel();
		this.input.hidden = true;
		host.append(this.input);
		this._register(toDisposable(() => this.input.remove()));
		this._register(
			addDisposableListener(tree.element, 'keydown', (event: KeyboardEvent) => {
				if (
					!(event.ctrlKey || event.metaKey) ||
					event.altKey ||
					event.shiftKey ||
					event.key.toLowerCase() !== 'f'
				)
					return;
				stopEvent(event);
				this.input.hidden = false;
				this.input.focus();
				this.input.select();
			}),
		);
		let root = tree.getInput();
		this._register(
			tree.onDidChangeLoadState(() => {
				if (tree.getInput() === root) return;
				root = tree.getInput();
				this.searchGeneration++;
				this.search.cancel();
				this.input.value = '';
				this.input.hidden = true;
				tree.clearFind();
			}),
		);
		this._register(
			addDisposableListener(this.input, 'input', () => {
				this.searchGeneration++;
				tree.setFindPattern(this.input.value);
				this.search.schedule();
			}),
		);
		this._register(
			addDisposableListener(this.input, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Escape') {
					stopEvent(event);
					this.searchGeneration++;
					this.search.cancel();
					this.input.value = '';
					this.input.hidden = true;
					tree.clearFind();
					tree.domFocus();
				} else if (event.key === 'Enter') {
					stopEvent(event);
					tree.findNext();
				}
			}),
		);
	}

	private async findWorkspaceNames(): Promise<void> {
		const generation = this.searchGeneration;
		const root = this.tree.getInput();
		const pattern = this.input.value;
		if (!root || !pattern) return;
		const queue = [root];
		const visited = new Set<string>();
		while (
			queue.length &&
			!this.isDisposed &&
			generation === this.searchGeneration &&
			this.tree.getInput() === root
		) {
			const directory = queue.shift()!;
			if (visited.has(directory.resource.toString())) continue;
			visited.add(directory.resource.toString());
			try {
				if (this.tree.getNode(directory).children === undefined)
					await this.tree.updateChildren(directory, { recursive: false });
				if (this.isDisposed || generation !== this.searchGeneration || this.tree.getInput() !== root) return;
				for (const node of this.tree.getNode(directory).children ?? []) {
					const item = node.element as ExplorerItem;
					if (item.kind === FileKind.Directory || item.children?.length) queue.push(item);
				}
			} catch {
				// An inaccessible folder must not prevent finding files in other roots.
			}
		}
		if (this.isDisposed || generation !== this.searchGeneration || this.tree.getInput() !== root) return;
		this.tree.setFindPattern(pattern);
		status(localize('accessibility.explorerSearchComplete', 'Finished finding workspace file names.'));
	}
}

export class FileSorter {
	private readonly names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

	constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {}

	public compare(left: ExplorerItem, right: ExplorerItem): number {
		const order = this.configurationService.getValue<SortOrder>('explorer.sortOrder') ?? SortOrder.Default;
		const leftDirectory = left.kind === FileKind.Directory;
		const rightDirectory = right.kind === FileKind.Directory;
		if (order !== SortOrder.Mixed && leftDirectory !== rightDirectory) {
			return (leftDirectory ? -1 : 1) * (order === SortOrder.FilesFirst ? -1 : 1);
		}
		let result = 0;
		if (order === SortOrder.Modified) {
			result = (right.mtime ?? 0) - (left.mtime ?? 0);
		} else if (order === SortOrder.Type && !leftDirectory) {
			result = this.names.compare(extension(left.name), extension(right.name));
		} else if (order === SortOrder.FoldersNestsFiles && !leftDirectory) {
			result = Number(!!right.children?.length) - Number(!!left.children?.length);
		}
		const lexical =
			this.configurationService.getValue<LexicographicOptions>('explorer.sortOrderLexicographicOptions') ??
			LexicographicOptions.Default;
		if (!result && lexical === LexicographicOptions.Unicode) {
			result = compareFileNamesUnicode(left.name, right.name);
		} else if (!result) {
			if (lexical !== LexicographicOptions.Default) {
				const leftUpper = /^\p{Lu}/u.test(left.name);
				const rightUpper = /^\p{Lu}/u.test(right.name);
				if (/^\p{L}/u.test(left.name) && /^\p{L}/u.test(right.name))
					result =
						(Number(rightUpper) - Number(leftUpper)) * (lexical === LexicographicOptions.Lower ? -1 : 1);
			}
			if (!result) result = compareFileNames(left.name, right.name);
		}
		return this.configurationService.getValue<boolean>('explorer.sortOrderReverse') ? -result : result;
	}
}

function extension(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1) : '';
}

export class ExplorerDataSource extends Disposable {
	private readonly excludes: ResourceGlobMatcher;

	constructor(
		private readonly sorter: FileSorter,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.excludes = this._register(
			new ResourceGlobMatcher(
				folder => configurationService.getValue<IExpression>('files.exclude', { resource: folder }),
				event => event.affectsConfiguration('files.exclude'),
				workspaceContextService,
				configurationService,
			),
		);
	}

	public hasChildren(item: ExplorerItem): boolean {
		return item.kind === FileKind.Directory || !!item.children?.length;
	}

	public async getChildren(item: ExplorerItem): Promise<readonly ExplorerItem[]> {
		if (item.children) {
			return item.children;
		}
		const raw = await this.fileService.readDirectory(item.resource);
		const siblings = new Set(raw.map(entry => entry.name));
		let entries = raw
			.filter(entry => !this.excludes.matches(entry.resource, name => siblings.has(name)))
			.map(ExplorerItem.fromFileEntry);
		if (this.configurationService.getValue<SortOrder>('explorer.sortOrder') === SortOrder.Modified) {
			entries = await Promise.all(
				entries.map(async entry => {
					const stat = await this.fileService.stat(entry.resource);
					return new ExplorerItem(
						entry.resource,
						entry.name,
						entry.kind,
						entry.children,
						stat.modifiedAtMillis,
					);
				}),
			);
		}
		entries.sort((left, right) => this.sorter.compare(left, right));
		if (!this.configurationService.getValue<boolean>(ExplorerFileNestingSettingId.Enabled)) {
			return entries;
		}
		const patterns = this.configurationService.getValue<Record<string, string>>(
			ExplorerFileNestingSettingId.Patterns,
		);
		const rules = Object.entries(patterns).map(
			([parent, children]) =>
				[
					parent,
					children
						.split(',')
						.map(child => child.trim())
						.filter(Boolean),
				] as const,
		);
		const files = entries.filter(entry => entry.kind === FileKind.File);
		const filesByName = new Map(files.map(file => [file.name, file]));
		const nests = new ExplorerFileNestingTrie(rules).nest(
			files.map(file => file.name),
			item.name,
		);
		const roots = entries.filter(entry => entry.kind !== FileKind.File);
		for (const [name, childNames] of nests) {
			const file = filesByName.get(name)!;
			const children = [...childNames]
				.map(child => filesByName.get(child)!)
				.sort((left, right) => this.sorter.compare(left, right));
			roots.push(
				children.length ? new ExplorerItem(file.resource, file.name, file.kind, children, file.mtime) : file,
			);
		}
		return roots.sort((left, right) => this.sorter.compare(left, right));
	}
}

/** Owns the labels and hovers created for the currently rendered tree rows. */
export class FilesRenderer extends Disposable {
	private readonly labels: ResourceLabels;
	private readonly renderedRows = this._register(new DisposableMap<HTMLElement, DisposableStore>());

	constructor(
		private readonly document: Document,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IResourceIconRenderer resourceIconRenderer: IResourceIconRenderer,
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDecorationsService decorationsService: IDecorationsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILabelService labelService: ILabelService,
	) {
		super();
		this.labels = this._register(
			new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
				workspaceContextService,
				resourceIconRenderer,
				decorationsService,
				labelService,
			}),
		);
	}

	public disposeRow(row: HTMLDivElement): void {
		const content = row.querySelector<HTMLElement>('.ash-explorer-row-content');
		if (content) this.renderedRows.deleteAndDispose(content);
	}

	public renderCompressedElements(items: readonly ExplorerItem[]): HTMLElement {
		const content = this.renderElement(
			items[items.length - 1]!,
			items.length > 1 ? items.map(item => item.name) : undefined,
		);
		if (items.length > 1) {
			content.classList.add('ash-explorer-compressed');
			content.querySelectorAll<HTMLElement>('.ash-icon-label-segment').forEach((segment, index) => {
				segment.dataset.explorerSegment = String(index);
				segment.dataset.resource = items[index]!.resource.toString();
			});
		}
		return content;
	}

	public renderElement(item: ExplorerItem, names?: readonly string[]): HTMLElement {
		const content = h(this.document, 'span');
		content.className = `ash-explorer-row-content ash-explorer-${item.kind}`;
		content.dataset.resource = item.resource.toString();
		const resources = this.renderedRows.set(content, new DisposableStore());
		const label = resources.add(this.labels.create(content));
		const decoration = provideDecorations(item);
		const options = {
			hidePath: true,
			extraClasses: ['ash-icon-label-wide-gap'],
			fileKind: item.kind,
			fileDecorations: {
				colors: this.configurationService.getValue<boolean>('explorer.decorations.colors') ?? true,
				badges: this.configurationService.getValue<boolean>('explorer.decorations.badges') ?? true,
			},
			...(decoration
				? {
						suffix:
							this.configurationService.getValue<boolean>('explorer.decorations.badges') === false
								? undefined
								: decoration.letter,
						ariaLabel: localize(
							'workbench.explorerDecoratedFile',
							'{0}, {1}',
							item.name,
							decoration.tooltip,
						),
					}
				: {}),
		};
		if (names) label.setResource({ resource: item.resource, name: names }, options);
		else label.setFile(item.resource, options);
		const labelText = label.element.querySelector<HTMLElement>('.ash-icon-label-text');
		resources.add(
			this.hoverService.setupHover({
				target: label.element,
				content: () =>
					labelText && labelText.scrollWidth > labelText.clientWidth
						? (names?.join('/') ?? item.name)
						: undefined,
				groupId: 'explorer.items',
			}),
		);
		if (item.kind === FileKind.File) {
			for (const contribution of explorerFileContribRegistry.create(
				this.instantiationService,
				content,
				resources,
			)) {
				contribution.setResource(item.resource);
				resources.add(toDisposable(() => contribution.setResource(undefined)));
			}
		}
		return content;
	}
}

/** Applies Explorer file operations to browser drag payloads; the tree owns drag feedback. */
export class FileDragAndDrop extends AbstractDisposable implements TreeDragAndDrop<ExplorerItem> {
	constructor(
		private readonly onError: (error: unknown) => void,
		private readonly resolveItems: (items: readonly ExplorerItem[]) => readonly ExplorerItem[],
		@IFileService private readonly files: IFileService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogs: IDialogService,
		@IPathService private readonly paths: IPathService,
	) {
		super();
	}

	protected disposeCore(): void {}

	public getDragURI(item: ExplorerItem): string | undefined {
		const source = this.resolveItems([item])[0] ?? item;
		return this.isRoot(source) ? undefined : source.resource.toString();
	}

	public getDragLabel(items: readonly ExplorerItem[]): string {
		return items.length === 1 ? items[0]!.name : localize('files.dragItems', '{0} items', items.length);
	}

	public onDragStart(data: TreeDragData<ExplorerItem>, event: DragEvent): void {
		if (!event.dataTransfer) return;
		event.dataTransfer.setData(
			'text/uri-list',
			this.resolveItems(data.elements)
				.map(item => item.resource.toString())
				.join('\r\n'),
		);
	}

	public onDragOver(
		data: TreeDragData<ExplorerItem>,
		target: ExplorerItem | undefined,
		_index: number | undefined,
		_sector: unknown,
		event: DragEvent,
	): boolean | TreeDragOverReaction {
		const directory = this.getDirectory(this.segmentTarget(target, event));
		const copy = this.isCopy(event) || data.kind === 'native';
		if (
			!this.configuration.getValue<boolean>('explorer.enableDragAndDrop') ||
			!directory ||
			this.files.hasCapability(directory, FileSystemProviderCapabilities.Readonly)
		)
			return false;
		if (
			data.elements.some(item => !(item instanceof ExplorerItem)) ||
			(!data.elements.length && !data.types.includes('Files') && !data.types.includes('text/uri-list'))
		)
			return false;
		const sources = data.kind === 'internal' ? this.resolveItems(data.elements) : data.elements;
		if (
			sources.some(
				item =>
					this.isRoot(item) ||
					(item.kind === FileKind.Directory &&
						extUriBiasedIgnorePathCase.isEqualOrParent(directory, item.resource)) ||
					(!copy && extUriBiasedIgnorePathCase.isEqual(dirname(item.resource), directory)),
			)
		)
			return false;
		return {
			accept: true,
			effect: copy ? 'copy' : 'move',
			autoExpand: true,
			...(target?.kind === FileKind.File ? { bubble: 'up' as const } : {}),
		};
	}

	public drop(
		data: TreeDragData<ExplorerItem>,
		target: ExplorerItem | undefined,
		index: number | undefined,
		sector: unknown,
		event: DragEvent,
	): void {
		if (!this.onDragOver(data, target, index, sector, event)) return;
		const directory = this.getDirectory(this.segmentTarget(target, event))!;
		const copy = this.isCopy(event) || data.kind === 'native';
		const workspaceId = this.workspace.getWorkspace().id;
		const uris =
			data.kind === 'native' && !data.files.length ? (event.dataTransfer?.getData('text/uri-list') ?? '') : '';
		void this.performDrop(
			{ ...data, elements: data.kind === 'internal' ? this.resolveItems(data.elements) : data.elements },
			directory,
			copy,
			workspaceId,
			uris,
		).catch(this.onError);
	}

	private segmentTarget(item: ExplorerItem | undefined, event: DragEvent): ExplorerItem | undefined {
		const segment =
			typeof Element !== 'undefined' && event.target instanceof Element
				? event.target.closest<HTMLElement>('[data-explorer-segment]')
				: null;
		if (!item || item.kind !== FileKind.Directory || !segment?.dataset.resource) return item;
		const resource = URI.parse(segment.dataset.resource);
		return extUriBiasedIgnorePathCase.isEqualOrParent(item.resource, resource)
			? new ExplorerItem(resource, basename(resource), FileKind.Directory)
			: item;
	}

	private getDirectory(item: ExplorerItem | undefined): URI | undefined {
		if (item?.resource.scheme === 'ash-workspace') return undefined;
		if (item) return item.kind === FileKind.Directory ? item.resource : dirname(item.resource);
		const folders = this.workspace.getWorkspace().folders;
		return folders.length === 1 ? folders[0]!.uri : undefined;
	}

	private isRoot(item: ExplorerItem): boolean {
		return (
			item.resource.scheme === 'ash-workspace' ||
			this.workspace
				.getWorkspace()
				.folders.some(folder => extUriBiasedIgnorePathCase.isEqual(folder.uri, item.resource))
		);
	}

	private isCopy(event: DragEvent): boolean {
		return isMacintosh ? event.altKey : event.ctrlKey;
	}

	private async performDrop(
		data: TreeDragData<ExplorerItem>,
		directory: URI,
		copy: boolean,
		workspaceId: string,
		uriList: string,
	): Promise<void> {
		const imported: ExplorerItem[] = [];
		for (const line of uriList.split(/\r?\n/).filter(line => line && !line.startsWith('#'))) {
			const resource = URI.parse(line);
			if (resource.scheme !== 'file')
				throw new TypeError(localize('files.invalidDropURI', 'Invalid dropped file URI.'));
			const stat = await this.files.stat(resource);
			imported.push(new ExplorerItem(resource, basename(resource), stat.kind));
		}
		const sources = [...data.elements, ...imported];
		if (
			sources.some(
				item =>
					item.kind === FileKind.Directory &&
					extUriBiasedIgnorePathCase.isEqualOrParent(directory, item.resource),
			)
		)
			throw new Error(localize('files.pasteIntoSelf', 'Cannot paste a folder into itself.'));
		const items = sources.filter(
			item =>
				!sources.some(
					parent =>
						parent !== item &&
						parent.kind === FileKind.Directory &&
						extUriBiasedIgnorePathCase.isEqualOrParent(item.resource, parent.resource),
				),
		);
		if (!copy && this.configuration.getValue<boolean>('explorer.confirmDragAndDrop')) {
			const confirmed = await this.dialogs.confirm({
				message: localize('files.dragMoveConfirm', 'Move {0} items to {1}?', items.length, basename(directory)),
				primaryButton: localize('files.dragMove', 'Move'),
			});
			if (!confirmed.confirmed) return;
		}
		for (const item of items) {
			if (this.isDisposed || workspaceId !== this.workspace.getWorkspace().id) return;
			if (!(await this.paths.hasValidBasename(directory, item.name)))
				throw new Error(localize('files.invalidDropName', 'Invalid file name: {0}', item.name));
			const target = await this.copyTarget(directory, item.name, copy);
			if (this.isDisposed || workspaceId !== this.workspace.getWorkspace().id) return;
			if (copy) await this.files.copy(item.resource, target);
			else await this.files.rename(item.resource, target, 'error');
		}
		for (const file of data.files) {
			if (this.isDisposed || workspaceId !== this.workspace.getWorkspace().id) return;
			if (!(await this.paths.hasValidBasename(directory, file.name)))
				throw new Error(localize('files.invalidDropName', 'Invalid file name: {0}', file.name));
			const target = await this.copyTarget(directory, file.name, true);
			const bytes = new Uint8Array(await file.arrayBuffer());
			if (this.isDisposed || workspaceId !== this.workspace.getWorkspace().id) return;
			await this.files.writeFileBytes(target, bytes, { create: true, overwrite: false });
		}
		status(localize('accessibility.explorerDropComplete', 'Finished transferring files.'));
	}

	private async copyTarget(directory: URI, name: string, copy: boolean): Promise<URI> {
		const target = directory.joinPathSegment(name);
		if (!copy) return target;
		const dot = name.lastIndexOf('.');
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const extension = dot > 0 ? name.slice(dot) : '';
		for (let index = 0; index < 10000; index++) {
			const candidate =
				index === 0
					? target
					: directory.joinPathSegment(`${stem} copy${index === 1 ? '' : ` ${index}`}${extension}`);
			try {
				await this.files.stat(candidate);
			} catch (error) {
				if (error instanceof FileNotFoundError) return candidate;
				throw error;
			}
		}
		throw new Error(localize('files.pasteNoName', 'Could not find an available file name.'));
	}
}
