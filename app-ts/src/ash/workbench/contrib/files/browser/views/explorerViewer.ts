import { addDisposableListener, h, stopEvent } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { FileKind, type IFileService } from '../../../../../platform/files/common/files.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import type { ILabelService } from '../../../../../platform/label/common/labelService.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IFileLabelDecorationService } from '../../../../services/labels/common/fileLabelDecorationService.js';
import type { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { DEFAULT_LABELS_CONTAINER, ResourceLabels, type IResourceIconRenderer } from '../../../../browser/labels.js';
import { ExplorerItem } from '../../common/explorerModel.js';
import { ExplorerFileNestingSettingId, ExplorerFileNestingTrie } from '../../common/explorerFileNestingTrie.js';
import { provideDecorations } from './explorerDecorationsProvider.js';
import { explorerFileContribRegistry, type IExplorerFileContribution } from '../explorerFileContrib.js';

/** Provides keyboard file-name finding over the Explorer's loaded tree. */
export class ExplorerFindProvider extends Disposable {
	private readonly input: HTMLInputElement;

	constructor(
		private readonly tree: { readonly element: HTMLElement; setFindPattern(pattern: string): void; findNext(): ExplorerItem | undefined; clearFind(): void; domFocus(): void },
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
		this._register(onDidChangeNls(updateLabel));
		this.input.hidden = true;
		host.append(this.input);
		this._register(toDisposable(() => this.input.remove()));
		this._register(addDisposableListener(tree.element, 'keydown', (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'f') return;
			stopEvent(event);
			this.input.hidden = false;
			this.input.focus();
			this.input.select();
		}));
		this._register(addDisposableListener(this.input, 'input', () => tree.setFindPattern(this.input.value)));
		this._register(addDisposableListener(this.input, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				stopEvent(event);
				this.input.value = '';
				this.input.hidden = true;
				tree.clearFind();
				tree.domFocus();
			} else if (event.key === 'Enter') {
				stopEvent(event);
				tree.findNext();
			}
		}));
	}
}

export class FileSorter {
	public compare(left: ExplorerItem, right: ExplorerItem): number {
		const leftDirectory = left.kind === FileKind.Directory;
		const rightDirectory = right.kind === FileKind.Directory;
		if (leftDirectory !== rightDirectory) {
			return leftDirectory ? -1 : 1;
		}
		return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
	}
}

export class ExplorerDataSource {
	constructor(
		private readonly fileService: IFileService,
		private readonly sorter: FileSorter,
		private readonly configurationService: IConfigurationService,
	) {}

	public hasChildren(item: ExplorerItem): boolean {
		return item.kind === FileKind.Directory || !!item.children?.length;
	}

	public async getChildren(item: ExplorerItem): Promise<readonly ExplorerItem[]> {
		if (item.children) {
			return item.children;
		}
		const entries = (await this.fileService.readDirectory(item.resource))
			.map(ExplorerItem.fromFileEntry)
			.sort((left, right) => this.sorter.compare(left, right));
		if (!this.configurationService.getValue<boolean>(ExplorerFileNestingSettingId.Enabled)) {
			return entries;
		}
		const patterns = this.configurationService.getValue<Record<string, string>>(ExplorerFileNestingSettingId.Patterns);
		const rules = Object.entries(patterns).map(([parent, children]) => [parent, children.split(',').map(child => child.trim()).filter(Boolean)] as const);
		const files = entries.filter(entry => entry.kind === FileKind.File);
		const filesByName = new Map(files.map(file => [file.name, file]));
		const nests = new ExplorerFileNestingTrie(rules).nest(files.map(file => file.name), item.name);
		const roots = entries.filter(entry => entry.kind === FileKind.Directory);
		for (const [name, childNames] of nests) {
			const file = filesByName.get(name)!;
			const children = [...childNames].map(child => filesByName.get(child)!).sort((left, right) => this.sorter.compare(left, right));
			roots.push(children.length ? new ExplorerItem(file.resource, file.name, file.kind, children) : file);
		}
		return roots.sort((left, right) => this.sorter.compare(left, right));
	}
}

/** Owns the labels and hovers created for the currently rendered tree rows. */
export class FilesRenderer extends Disposable {
	private readonly labels: ResourceLabels;
	private readonly renderedLabels = this._register(new DisposableStore());
	private readonly contributions: IExplorerFileContribution[] = [];

	constructor(
		private readonly document: Document,
		workspaceContextService: IWorkspaceContextService,
		resourceIconRenderer: IResourceIconRenderer,
		private readonly hoverService: IHoverService,
		private readonly instantiationService: IInstantiationService,
		fileLabelDecorationService?: IFileLabelDecorationService,
		labelService?: ILabelService,
	) {
		super();
		this.labels = this._register(new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
			workspaceContextService,
			resourceIconRenderer,
			fileLabelDecorationService,
			labelService,
		}));
	}

	public clear(): void {
		for (const contribution of this.contributions) {
			contribution.setResource(undefined);
		}
		this.contributions.length = 0;
		this.renderedLabels.clear();
	}

	public renderElement(item: ExplorerItem): HTMLElement {
		const content = h(this.document, 'span');
		content.className = `ash-explorer-row-content ash-explorer-${item.kind}`;
		const label = this.renderedLabels.add(this.labels.create(content));
		const decoration = provideDecorations(item);
		label.setFile(item.resource, {
			fileKind: item.kind,
			fileDecorations: { colors: true, badges: true },
			...(decoration ? {
				suffix: decoration.letter,
				ariaLabel: localize('workbench.explorerDecoratedFile', '{0}, {1}', item.name, decoration.tooltip),
			} : {}),
		});
		const labelText = label.element.querySelector<HTMLElement>('.ash-icon-label-text');
		this.renderedLabels.add(this.hoverService.setupHover({
			target: label.element,
			content: () => labelText && labelText.scrollWidth > labelText.clientWidth ? item.name : undefined,
			groupId: 'explorer.items',
		}));
		if (item.kind === FileKind.File) {
			for (const contribution of explorerFileContribRegistry.create(this.instantiationService, content, this.renderedLabels)) {
				contribution.setResource(item.resource);
				this.contributions.push(contribution);
			}
		}
		return content;
	}
}
