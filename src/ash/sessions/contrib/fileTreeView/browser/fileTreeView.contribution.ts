import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IChatWidgetService, type IChatWidget } from '../../../../workbench/contrib/chat/browser/chat.js';
import { IChatAttachmentResolveService } from '../../../../workbench/contrib/chat/browser/attachments/chatAttachmentResolveService.js';
import { URI } from '../../../../base/common/uri.js';
import { IAccountService } from '../../../../platform/accounts/common/accountService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem, type IQuickPickItemButton } from '../../../../platform/quickinput/common/quickInput.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { FileSystemFileSearchProvider } from '../../../../workbench/services/search/common/fileSystemFileSearchProvider.js';
import { QueryType, SearchProviderType, ISearchService } from '../../../../workbench/services/search/common/search.js';
import { localize, localize2 } from '../../../../nls.js';
import { GITHUB_REMOTE_FILE_SCHEME } from '../../../services/sessions/common/session.js';
import { GitHubFileSystemProvider } from './githubFileSystemProvider.js';

class GitHubFileSystemProviderContribution extends Disposable {
	constructor(
		@IFileService files: IFileService,
		@ISearchService search: ISearchService,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const provider = this._register(instantiation.createInstance(GitHubFileSystemProvider));
		this._register(files.registerProvider(GITHUB_REMOTE_FILE_SCHEME, provider));
		const discovery = this._register(instantiation.createInstance(FileSystemFileSearchProvider));
		this._register(search.registerSearchResultProvider(GITHUB_REMOTE_FILE_SCHEME, SearchProviderType.file, discovery));
	}
}

registerWorkbenchContribution('workbench.contrib.githubFileSystemProvider', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(GitHubFileSystemProviderContribution));

registerAction2(class BrowseGitHubRepositoryFilesAction extends Action2 {
	constructor() {
		super({ id: 'sessions.github.browseRepositoryFiles', title: localize2('github.files.browse', 'GitHub: Browse Repository Files'), precondition: IsSessionsWindowContext.isEqualTo(true), f1: true });
	}

	public override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
		const quick = accessor.get(IQuickInputService);
		const files = accessor.get(IFileService);
		const search = accessor.get(ISearchService);
		const editors = accessor.get(IEditorService);
		const accounts = accessor.get(IAccountService);
		const notifications = accessor.get(INotificationService);
		const widgets = accessor.get(IChatWidgetService);
		const attachments = accessor.get(IChatAttachmentResolveService);
		const configuration = accessor.get(IConfigurationService);
		let root: URI;
		if (value !== undefined) {
			if (typeof value !== 'string') { throw new TypeError(localize('github.files.invalidRepository', 'Enter owner/name or a GitHub repository HTTPS URL.')); }
			root = URI.parse(value, true);
		} else {
			const repository = await quick.input({ title: localize('github.files.browse', 'GitHub: Browse Repository Files'), placeHolder: localize('github.files.repository', 'owner/name or https://github.com/owner/name') });
			if (repository === undefined) { return; }
			let url: URL;
			try { url = new URL(repository.includes('://') ? repository.trim() : `https://github.com/${repository.trim()}`); }
			catch { throw new TypeError(localize('github.files.invalidRepository', 'Enter owner/name or a GitHub repository HTTPS URL.')); }
			const parts = url.pathname.replace(/\/$/, '').split('/').slice(1);
			if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || parts.length !== 2 || parts.some(part => !/^[a-z0-9_.-]+$/i.test(part) || part === '.' || part === '..')) {
				throw new TypeError(localize('github.files.invalidRepository', 'Enter owner/name or a GitHub repository HTTPS URL.'));
			}
			const reference = await quick.input({ title: localize('github.files.reference', 'Branch, tag or commit'), value: 'HEAD' });
			if (reference === undefined) { return; }
			root = URI.from({ scheme: GITHUB_REMOTE_FILE_SCHEME, authority: url.hostname === 'github.com' ? 'github' : url.hostname, path: `/${parts[0]}/${parts[1].replace(/\.git$/, '')}/${encodeURIComponent(reference)}` });
		}
		if (root.scheme !== GITHUB_REMOTE_FILE_SCHEME || (await files.stat(root)).kind !== FileKind.Directory) { throw new TypeError(localize('github.files.invalidRepository', 'Enter owner/name or a GitHub repository HTTPS URL.')); }
		using resources = new DisposableStore();
		const picker = resources.add(quick.createQuickPick<IQuickPickItem & { readonly resource?: URI; }>());

		picker.sortByLabel = false;
		let pending: CancellationTokenSource | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		let attaching = false;
		const lifetime = new AbortController();
		const canAttach = (): boolean => configuration.getValue<boolean>('chat.disableAIFeatures') !== true;
		const attachButton = { id: 'attach', label: localize('github.files.attach', 'Add to current Agent context') };
		const buttons = (): readonly IQuickPickItemButton[] => canAttach() ? [attachButton] : [];
		const updatePrompt = (): void => {
			picker.ariaLabel = picker.placeholder = canAttach()
				? localize('github.files.search', 'Search repository files; Enter opens read-only, Tab reaches Add to current Agent context, Escape cancels')
				: localize('github.files.searchReadOnly', 'Search repository files; Enter opens read-only, Escape cancels');
		};
		updatePrompt();
		const update = async (pattern: string): Promise<void> => {
			pending?.cancel(); pending?.dispose();
			const source = pending = new CancellationTokenSource();
			picker.busy = true;
			try {
				const result = await search.fileSearch({ type: QueryType.File, folderQueries: [{ folder: root }], filePattern: pattern, sortByScore: true, maxResults: 200 }, source.token);
				if (closed || source.token.isCancellationRequested) { return; }
				picker.items = result.results.map(({ resource }) => ({ label: resource.path.slice(root.path.replace(/\/$/, '').length + 1), resource, buttons: buttons() }));
				if (!result.results.length) { picker.items = [{ label: localize('github.files.noMatches', 'No matching files'), alwaysShow: true }]; }
				if (result.limitHit) { picker.items = [...picker.items, { label: localize('github.files.more', 'Type more to narrow the results'), alwaysShow: true }]; }
			} catch (error) {
				if (!closed && !source.token.isCancellationRequested && !isCancellationError(error)) { notifications.error(error instanceof Error ? error.message : String(error)); picker.hide(); }
			} finally { if (!closed && !attaching && pending === source) { picker.busy = false; } }
		};
		const selected = await new Promise<{ readonly resource: URI; } | { readonly attachedTo: IChatWidget; } | undefined>(resolve => {
			resources.add(picker.onDidTriggerItemButton(({ item, button }) => {
				if (button.id !== attachButton.id || !item.resource || picker.busy || attaching || !canAttach()) { return; }
				const visible = widgets.getAllWidgets().filter(widget => widget.visible);
				const widget = widgets.lastFocusedWidget ?? (visible.length === 1 ? visible[0] : undefined);
				if (!widget) {
					notifications.warn(localize('github.files.noAgent', 'Open an Agent conversation before adding a file.'));
					return;
				}
				const resource = item.resource;
				attaching = true;
				picker.busy = true;
				const attach = async (): Promise<void> => {
					try {
						const accepted = await widget.acquireContext(async signal => {
							const attachment = await attachments.resolveResourceAttachContext(resource, false, signal);
							if (!canAttach()) { throw new CancellationError(); }
							return [attachment];
						}, lifetime.signal);
						if (closed || lifetime.signal.aborted || !accepted.length) { return; }
						status(localize('github.files.added', 'Added {0} to Agent context.', item.label));
						resolve({ attachedTo: widget });
						picker.hide();
					} catch (error) {
						if (!closed && !isCancellationError(error)) {
							notifications.error(localize('github.files.attachFailed', 'Could not add {0} to Agent context: {1}', item.label, error instanceof Error ? error.message : String(error)));
						}
					} finally {
						attaching = false;
						if (!closed) { picker.busy = false; }
					}
				};
				void attach();
			}));
			resources.add(configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('chat.disableAIFeatures')) {
					updatePrompt();
					if (attaching && !canAttach()) { picker.hide(); return; }
					picker.items = picker.items.map(item => 'resource' in item && item.resource ? { ...item, buttons: buttons() } : item);
				}
			}));
			resources.add(picker.onDidChangeValue(value => {
				if (attaching) { return; }
				pending?.cancel();
				picker.items = [];
				clearTimeout(timer);
				timer = setTimeout(() => { void update(value); }, 150);
			}));
			resources.add(picker.onDidAccept(() => {
				const resource = picker.activeItems[0]?.resource;
				if (resource && !picker.busy) { resolve({ resource }); picker.hide(); }
			}));
			resources.add(picker.onDidHide(() => {
				closed = true;
				lifetime.abort();
				clearTimeout(timer);
				pending?.cancel();
				resolve(undefined);
			}));
			resources.add(accounts.onDidChangeAccounts(() => picker.hide()));
			resources.add(toDisposable(() => { lifetime.abort(); clearTimeout(timer); pending?.cancel(); pending?.dispose(); }));
			picker.show();
			void update('');
		});
		if (selected && 'resource' in selected) { await editors.openEditor({ resource: selected.resource, readOnly: true }); }
		else if (selected && selected.attachedTo.visible) { selected.attachedTo.inputEditor?.focus(); }
	}
});
