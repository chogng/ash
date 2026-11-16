import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import { status as announceStatus } from '../../../../../base/browser/ui/aria/aria.js';
import './browserDownloads.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { ContextView, ContextViewFocusRestore } from '../../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { IBrowserDownloadService, BrowserDownloadDirectorySetting, BrowserDownloadAskSetting, type BrowserDownload } from '../../../../../platform/browserView/common/browserDownloads.js';
import { IContextViewService, IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { defaultInputBoxStyles, defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IAccessibleViewService, AccessibleViewType, AccessibleContentProvider, AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { createServiceIdentifier, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';

export interface IBrowserDownloadsView { show(anchor?: HTMLElement): Promise<void>; }
export const IBrowserDownloadsView = createServiceIdentifier<IBrowserDownloadsView>('browserDownloadsView');
const text = {
	title: () => localize({ bundle: 'ash', key: 'downloads.title' }, 'Downloads'),
	open: () => localize({ bundle: 'ash', key: 'downloads.open' }, 'Open file'),
	show: () => isMacintosh ? localize({ bundle: 'ash', key: 'downloads.finder' }, 'Show in Finder') : localize({ bundle: 'ash', key: 'downloads.folder' }, 'Show in folder'),
	copy: () => localize({ bundle: 'ash', key: 'downloads.copy' }, 'Copy download link'),
	deleteFile: () => localize({ bundle: 'ash', key: 'downloads.deleteFile' }, 'Delete file'),
	remove: () => localize({ bundle: 'ash', key: 'downloads.remove' }, 'Remove from list'),
};

/** A window-owned view of Main's download records; no file paths are accepted as commands. */
export class BrowserDownloadsView extends Disposable implements IBrowserDownloadsView {
	private readonly popup = this._register(new MutableDisposable<DisposableStore>());
	private revision = 0;
	constructor(
		@IBrowserDownloadService private readonly downloads: IBrowserDownloadService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService private readonly accessible: IAccessibleViewService,
		@IHoverService private readonly hover: IHoverService,
	) { super(); }
	async show(anchor?: HTMLElement): Promise<void> {
		if (this.popup.value) { this.popup.clear(); if (anchor) return; }
		const revision = ++this.revision;
		const container = this.contextViews.container;
		const document = container.ownerDocument;
		const trigger = anchor ?? (isHTMLElement(document.activeElement) ? document.activeElement : undefined);
		const dialog = trigger?.closest<HTMLElement>('dialog[open]');
		let state = await this.downloads.getState();
		if (this.isDisposed || revision !== this.revision || dialog && (!dialog.isConnected || !dialog.hasAttribute('open'))) return;
		const resources = new DisposableStore();
		this.popup.value = resources;
		const root = h(document, 'section', { className: 'ash-browser-downloads' });
		root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', text.title());
		root.setAttribute('aria-description', this.accessible.getOpenAriaHint(AccessibilityVerbositySettingId.Browser) ?? '');
		const search = resources.add(new InputBox(root, {
			inputBoxStyles: defaultInputBoxStyles,
			placeholder: localize({ bundle: 'ash', key: 'downloads.search' }, 'Search downloads'), ariaLabel: localize({ bundle: 'ash', key: 'downloads.search' }, 'Search downloads')
		}));
		const list = h(document, 'div', { className: 'ash-browser-download-list' });
		list.setAttribute('role', 'list'); list.setAttribute('aria-label', text.title()); root.append(list);
		const rows = resources.add(new DisposableStore());
		// A settings action must keep the panel inside that modal's native focus scope.
		const view = resources.add(new ContextView(dialog ?? container));
		let menuOpen = false;
		let fetchRevision = 0;
		const run = (entry: BrowserDownload, action: 'open' | 'show' | 'deleteFile' | 'remove' | 'copy'): void => {
			void (action === 'copy' ? this.clipboard.writeText(entry.url).then(() => announceStatus(localize({ bundle: 'ash', key: 'downloads.copied' }, 'Download link copied'))) : this.downloads.perform(entry.id, action))
				.catch(error => this.notifications.error(error));
		};
		const menu = (entry: BrowserDownload, row: HTMLElement, event?: MouseEvent): void => {
			menuOpen = true;
			this.menus.showContextMenu({
				getAnchor: () => event ? { x: event.clientX, y: event.clientY, targetWindow: document.defaultView! } : row,
				iconPlacement: 'leading-with-trailing-check',
				getMenuClassName: () => 'ash-browser-download-menu',
				getActions: () => (['open', 'show', 'copy', 'deleteFile', 'remove'] as const).map(action => ({
					id: 'download.' + action, label: text[action](), tooltip: '',
					enabled: action === 'copy' ? !!entry.url : action === 'remove' ? entry.state !== 'progressing' : entry.state === 'completed',
					run: () => run(entry, action),
				})),
				onHide: () => { menuOpen = false; if (row.isConnected) row.focus(); },
			});
		};
		const render = (): void => {
			const focused = isHTMLElement(document.activeElement) ? document.activeElement.closest<HTMLElement>('[data-download-id]')?.dataset.downloadId : undefined;
			rows.clear(); list.replaceChildren();
			const query = search.value.trim().toLocaleLowerCase();
			const items = state.items.filter(entry => (entry.filename + ' ' + entry.url).toLocaleLowerCase().includes(query));
			for (const entry of items) {
				const row = h(document, 'div', { className: 'ash-browser-download-row' });
				row.dataset.downloadId = entry.id; row.tabIndex = 0; row.setAttribute('role', 'listitem');
				const copy = h(document, 'div', { className: 'ash-browser-download-copy' });
				const name = h(document, 'div', { className: 'ash-browser-download-name' }); name.textContent = entry.filename; rows.add(this.hover.setupDelayedHover(name, { content: entry.filename }));
				const detail = h(document, 'div', { className: 'ash-browser-download-detail' });
				const status = {
					progressing: localize({ bundle: 'ash', key: 'downloads.progressing' }, 'Downloading'),
					completed: localize({ bundle: 'ash', key: 'downloads.completed' }, 'Completed'),
					cancelled: localize({ bundle: 'ash', key: 'downloads.cancelled' }, 'Cancelled'),
					interrupted: localize({ bundle: 'ash', key: 'downloads.interrupted' }, 'Interrupted'),
					deleted: localize({ bundle: 'ash', key: 'downloads.deleted' }, 'File deleted'),
				}[entry.state];
				detail.textContent = localize({ bundle: 'ash', key: 'downloads.status' }, '{0} · {1} / {2} bytes', status, entry.receivedBytes, entry.totalBytes);
				rows.add(this.hover.setupDelayedHover(detail, { content: entry.path || entry.url })); copy.append(name, detail); row.append(copy);
				const actions = h(document, 'div', { className: 'ash-browser-download-actions' }); row.append(actions);
				for (const [action, icon] of [['show', Lxicon.folder], ['deleteFile', Lxicon.trash]] as const) {
					const button = rows.add(new Button(actions, {
						...defaultButtonStyles, label: text[action](), ariaLabel: localize({ bundle: 'ash', key: 'downloads.fileAction' }, '{0}: {1}', text[action](), entry.filename),
						icon, iconOnly: true, size: 'small', presentation: 'quiet', enabled: entry.state === 'completed'
					}));
					rows.add(button.onDidClick(() => run(entry, action)));
				}
				rows.add(addDisposableListener(row, 'contextmenu', event => { event.preventDefault(); menu(entry, row, event); }));
				rows.add(addDisposableListener<KeyboardEvent>(row, 'keydown', event => {
					if (event.target !== row) return;
					if (event.key === 'Enter') { event.preventDefault(); if (entry.state === 'completed') run(entry, 'open'); }
					else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); menu(entry, row); }
					else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
						if (isHTMLElement(next)) { next.focus(); next.scrollIntoView({ block: 'nearest' }); }
					}
				}));
				rows.add(addDisposableListener(row, 'dblclick', event => { if (event.target === row || copy.contains(event.target as Node)) { if (entry.state === 'completed') run(entry, 'open'); } }));
				list.append(row);
				if (focused === entry.id) row.focus();
			}
			if (!items.length) { const empty = h(document, 'p'); empty.textContent = localize({ bundle: 'ash', key: 'downloads.empty' }, 'No downloads'); list.append(empty); }
			view.layout();
		};
		resources.add(search.onDidChange(render));
		resources.add(addDisposableListener<KeyboardEvent>(search.inputElement, 'keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); list.querySelector<HTMLElement>('[data-download-id]')?.focus(); } }));
		resources.add(this.downloads.onDidChange(() => {
			const request = ++fetchRevision;
			void this.downloads.getState().then(next => { if (this.popup.value === resources && request === fetchRevision) { state = next; render(); } }).catch(error => this.notifications.error(error));
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) resources.add(AccessibleViewRegistry.register({
			type, name: 'browser-downloads-' + type, priority: 120,
			getProvider: () => {
				const focused = document.activeElement;
				if (!isHTMLElement(focused) || !root.contains(focused)) return undefined;
				return new AccessibleContentProvider(AccessibleViewProviderId.Browser, { type }, () => type === AccessibleViewType.View
					? [text.title(), ...Array.from(list.children, row => row.textContent ?? '')].join('\n')
					: localize({ bundle: 'ash', key: 'downloads.help' }, 'Downloads\nType in Search downloads to filter by filename or link. Down moves to the list. Use Up and Down to move between downloads. Enter opens a completed file. Shift+F10 opens its menu: Open file, Show in folder or Finder, Copy download link, Delete file and Remove from list. Tab reaches the folder and delete buttons. Delete file moves the file to Trash or Recycle Bin. Remove from list only removes the record. Escape closes this panel and returns focus to its trigger.'),
					() => focused.isConnected && focused.focus(), AccessibilityVerbositySettingId.Browser);
			},
		}));
		render();
		view.show({
			anchor: anchor ?? (dialog ? trigger : undefined) ?? { left: container.clientWidth / 2, top: 80, width: 0, height: 0 }, content: root,
			presentation: 'menu', focusRestore: ContextViewFocusRestore.Previous,
			isTargetWithin: target => root.contains(target) || menuOpen,
			onHide: () => { if (this.popup.value === resources) this.popup.clear(); },
		});
		search.focus();
	}
}
registerSingleton(IBrowserDownloadsView, BrowserDownloadsView, InstantiationType.Delayed);
registerWorkbenchContribution('workbench.contrib.browserDownloads', WorkbenchPhase.BlockRestore, accessor => {
	const store = new DisposableStore();
	const configuration = accessor.get(IConfigurationService);
	const downloads = accessor.get(IBrowserDownloadService);
	const notifications = accessor.get(INotificationService);
	const configure = (): void => { void downloads.configure(configuration.getValue<string>(BrowserDownloadDirectorySetting), configuration.getValue<boolean>(BrowserDownloadAskSetting)).catch(error => notifications.error(error)); };
	store.add(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(BrowserDownloadDirectorySetting) || event.affectsConfiguration(BrowserDownloadAskSetting)) configure(); }));
	store.add(CommandsRegistry.register('workbench.action.browser.chooseDownloadDirectory', async () => {
		const directory = await downloads.chooseDirectory();
		if (directory) await configuration.updateValue(BrowserDownloadDirectorySetting, directory, ConfigurationTarget.USER);
	}));
	store.add(CommandsRegistry.register('workbench.action.browser.showDownloads', (services: ServicesAccessor) => services.get(IBrowserDownloadsView).show()));
	configure(); return store;
});
