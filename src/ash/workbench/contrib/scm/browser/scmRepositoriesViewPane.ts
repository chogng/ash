import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { CountBadge } from '../../../../base/browser/ui/countBadge/countBadge.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IHoverService } from '../../../../platform/hover/browser/hoverService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ISCMService, ISCMViewService, type ISCMRepository } from '../common/scm.js';
import './media/scmRepositories.css';

export const REPOSITORIES_VIEW_PANE_ID = 'workbench.scm.repositories';

interface RepositoryRow {
	readonly domNode: HTMLElement;
	readonly name: HTMLElement;
	readonly branch: HTMLElement;
	readonly path: HTMLElement;
	readonly badge: CountBadge;
}

/** Repository selection shared by Changes, Graph and the status bar. */
export class SCMRepositoriesViewPane extends ViewPane {
	private readonly list: List<ISCMRepository>;
	private readonly providerListeners = this._register(new DisposableMap<string, IDisposable>());
	private readonly rowResources = this._register(new DisposableMap<HTMLElement, DisposableStore>());
	private readonly rows = new Map<string, RepositoryRow>();
	private readonly statusDomNode: HTMLElement;
	private isSwitching = false;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IHoverService private readonly hoverService: IHoverService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super(container, { ...options, minimumBodySize: 44 });
		this.contentElement.classList.add('ash-scm-repositories');
		this.list = this._register(new List<ISCMRepository>(this.contentElement, {
			ariaLabel: localize('scm.repositories.label', 'Source control repositories'),
			domFocusable: true,
			keyboardNavigation: true,
			focusOnMouseMove: false,
			loopNavigation: false,
			scrolling: 'managed',
			getId: repository => repository.id,
			accessibilityProvider: { getAriaLabel: repository => this.repositoryDescription(repository) },
			reuseRows: true,
			renderItem: repository => this.renderRepository(repository),
			updateItem: repository => this.updateRepository(repository),
			onDidRemoveRow: row => this.rowResources.deleteAndDispose(row.firstElementChild as HTMLElement),
		}));
		this.list.element.classList.add('ash-scm-repositories-list');
		const updateHelp = (): void => {
			const hint = configurationService.getValue<boolean>(AccessibilityVerbositySettingId.ScmRepositories)
				? localize('scm.repositories.helpHint', 'Press Alt+F1 for accessibility help.') : '';
			this.list.element.setAttribute('aria-description', hint);
		};
		updateHelp();
		this._register(configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ScmRepositories)) updateHelp();
		}));
		this.statusDomNode = h(container.ownerDocument, 'div');
		this.statusDomNode.className = 'ash-scm-repositories-status ash-aria-live';
		this.statusDomNode.setAttribute('role', 'status');
		this.contentElement.append(this.statusDomNode);
		this._register(this.list.onDidAccept(event => void this.selectRepository(event.item)));
		this._register(this.list.onDidChangeSelection(event => {
			// Keyboard navigation moves focus; the shared repository changes only on acceptance.
			if (event.browserEvent) this.updateSelection();
		}));
		this._register(this.list.onDidChangeActive(() => {
			for (const repository of this.list.items) this.updateRepository(repository);
		}));
		this._register(addDisposableListener(this.list.element, 'keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			this.list.acceptActive(event);
		}));
		this._register(scmService.onDidAddRepository(() => this.syncRepositories()));
		this._register(scmService.onDidRemoveRepository(() => this.syncRepositories()));
		this._register(scmViewService.onDidChangeActiveRepository(() => {
			this.updateSelection();
			for (const repository of this.list.items) this.updateRepository(repository);
		}));
		this._register(this.onDidChangeBodyVisibility(visible => {
			if (visible) this.syncRepositories();
		}));
	}

	public override focus(): void { this.list.domFocus(); }

	protected override layoutBody(height: number, _width: number): void { this.list.layout(height); }

	private syncRepositories(): void {
		const repositories = [...this.scmService.repositories];
		const ids = new Set(repositories.map(repository => repository.id));
		for (const id of this.providerListeners.keys()) {
			if (!ids.has(id)) this.providerListeners.deleteAndDispose(id);
		}
		for (const repository of repositories) {
			if (!this.providerListeners.has(repository.id)) this.providerListeners.set(repository.id, repository.provider.onDidChangeResources(() => this.updateRepository(repository)));
		}
		this.list.items = repositories;
		this.updateSelection();
	}

	private updateSelection(): void {
		const index = this.list.items.findIndex(repository => repository.id === this.scmViewService.activeRepository?.id);
		this.list.setSelection(index < 0 ? [] : [index]);
	}

	private renderRepository(repository: ISCMRepository): HTMLElement {
		const document = this.element.ownerDocument;
		const domNode = h(document, 'div');
		domNode.className = 'ash-scm-repository';
		const name = h(document, 'span');
		name.className = 'ash-scm-repository-name';
		const branch = h(document, 'span');
		branch.className = 'ash-scm-repository-branch';
		const path = h(document, 'span');
		path.className = 'ash-scm-repository-path';
		const resources = new DisposableStore();
		this.rowResources.set(domNode, resources);
		const badge = resources.add(new CountBadge(domNode, { count: 0, titleFormat: localize('scm.repositories.changes', '{0} changed files') }));
		domNode.append(name, branch, badge.domNode, path);
		this.rows.set(repository.id, { domNode, name, branch, path, badge });
		resources.add(toDisposable(() => this.rows.delete(repository.id)));
		resources.add(this.hoverService.setupDelayedHover(domNode, () => ({ content: this.repositoryDescription(repository) })));
		this.updateRepository(repository);
		return domNode;
	}

	private repositoryDescription(repository: ISCMRepository): string {
		const count = new Set(repository.provider.groups.flatMap(group => group.resources.map(resource => extUriBiasedIgnorePathCase.getComparisonKey(resource.sourceUri)))).size;
		return localize('scm.repositories.description', '{0}, {1}, {2} changed files', repository.provider.label, repository.provider.activeRepositoryName ?? '', count)
			+ (repository.provider.rootUri ? `\n${repository.provider.rootUri.fsPath}` : '');
	}

	private updateRepository(repository: ISCMRepository): void {
		const row = this.rows.get(repository.id);
		if (!row) return;
		row.name.textContent = repository.provider.label;
		const branch = repository.provider.activeRepositoryName ?? '';
		row.branch.textContent = /^[\da-f]{40,64}$/u.test(branch) ? branch.slice(0, 8) : branch;
		const duplicates = [...this.scmService.repositories].filter(candidate => candidate.provider.label === repository.provider.label && candidate.provider.rootUri);
		let path = '';
		if (duplicates.length > 1 && repository.provider.rootUri) {
			const segments = repository.provider.rootUri.fsPath.split(/[\\/]/u);
			let length = 1;
			while (length < segments.length && duplicates.some(candidate => candidate.id !== repository.id && candidate.provider.rootUri!.fsPath.split(/[\\/]/u).slice(-length).join('/') === segments.slice(-length).join('/'))) length++;
			path = segments.slice(-length).join('/');
		}
		row.path.textContent = path;
		row.domNode.classList.toggle('has-path', path.length > 0);
		row.domNode.classList.toggle('checked', repository.id === this.scmViewService.activeRepository?.id);
		row.domNode.classList.toggle('focused', repository.id === this.list.activeItem?.id);
		row.badge.setCount(new Set(repository.provider.groups.flatMap(group => group.resources.map(resource => extUriBiasedIgnorePathCase.getComparisonKey(resource.sourceUri)))).size);
		this.list.row(this.list.items.indexOf(repository))?.setAttribute('aria-label', this.repositoryDescription(repository));
	}

	private async selectRepository(repository: ISCMRepository): Promise<void> {
		if (this.isSwitching || repository.id === this.scmViewService.activeRepository?.id) return;
		this.isSwitching = true;
		this.list.element.setAttribute('aria-busy', 'true');
		this.statusDomNode.textContent = '';
		try {
			await repository.provider.activate();
			if (this.isDisposed || this.scmService.getRepository(repository.id) !== repository) return;
			this.scmViewService.selectRepository(repository.id);
			status(localize('scm.repositories.selected', 'Selected repository {0}', repository.provider.label));
		} catch (error) {
			if (!this.isDisposed) this.statusDomNode.textContent = localize('scm.repositories.selectFailed', 'Could not select repository: {0}', error instanceof Error ? error.message : String(error));
		} finally {
			this.isSwitching = false;
			if (!this.isDisposed) {
				this.list.element.setAttribute('aria-busy', 'false');
				this.updateSelection();
			}
		}
	}
}
