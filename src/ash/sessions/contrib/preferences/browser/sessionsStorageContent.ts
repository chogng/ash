import './media/sessionsStorageContent.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IProfileStorageService, type ProfileStorageWorktree } from '../../../../platform/storage/common/profileStorageService.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { SettingsPageRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import type { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import type { SettingsSectionReference, SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';

export const storageSettingsTitle = () => localize({ bundle: 'ash.sessions', key: 'sessions.storage.title' }, 'Storage');

export class SessionsStorageContent extends SettingsPageRenderer<SettingsSectionReference> {
	readonly categoryId = 'storage';
	readonly onDidChange = Event.None;
	private readonly domNode: HTMLElement;
	private readonly total: HTMLElement;
	private readonly chart: HTMLElement;
	private readonly legend: HTMLElement;
	private readonly roots: HTMLElement;
	private readonly status: HTMLElement;
	private readonly refreshButton: Button;
	private readonly worktreeSummary: HTMLElement;
	private readonly worktreeList: HTMLElement;
	private readonly cleanupStatus: HTMLElement;
	private readonly cleanupButton: Button;
	private readonly worktreeControls = this._register(new DisposableStore());
	private worktrees: readonly { readonly worktree: ProfileStorageWorktree; readonly checkbox: Checkbox; }[] = [];
	private request: AbortController | undefined;
	private loaded = false;
	private searching = false;
	private cleaning = false;

	constructor(container: HTMLElement, openSessionAction: (action: 'restore' | 'delete') => Promise<void>,
		@IProfileStorageService private readonly storage: IProfileStorageService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section', { className: 'ash-sessions-storage' });
		const summary = h(document, 'div', { className: 'ash-sessions-storage-summary' });
		const header = h(document, 'div', { className: 'ash-sessions-storage-header' });
		this.total = h(document, 'h2', { className: 'ash-sessions-storage-total' });
		this.total.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.local' }, 'Local profile');
		header.append(this.total);
		this.refreshButton = this._register(new Button(header, {
			...defaultButtonStyles, presentation: 'secondary', size: 'small',
			label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.refresh' }, 'Refresh'),
			onClick: () => { void this.refresh(); },
		}));
		this.chart = h(document, 'div', { className: 'ash-sessions-storage-chart', attributes: { 'aria-hidden': 'true' } });
		this.chart.hidden = true;
		this.legend = h(document, 'ul', { className: 'ash-sessions-storage-legend' });
		this.roots = h(document, 'p', { className: 'ash-sessions-storage-details' });
		this.status = h(document, 'p', { className: 'ash-sessions-storage-details', attributes: { role: 'status' } });
		summary.append(header, this.chart, this.legend, this.roots, this.status);
		this.domNode.append(summary);

		const archive = h(document, 'div', { className: 'ash-settings-field-row' });
		const copy = h(document, 'div', { className: 'ash-settings-field-copy' });
		const title = h(document, 'h2');
		title.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.archive' }, 'Archived sessions');
		const description = h(document, 'p', { className: 'ash-settings-field-description' });
		description.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.archiveDescription' }, 'Restore an archived session or permanently delete its conversation history.');
		copy.append(title, description);
		archive.append(copy);
		this._register(new Button(archive, {
			...defaultButtonStyles, presentation: 'secondary', size: 'small',
			label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.restore' }, 'Restore'),
			onClick: () => { void openSessionAction('restore'); },
		}));
		this._register(new Button(archive, {
			...defaultButtonStyles, presentation: 'secondary', size: 'small',
			label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.delete' }, 'Review for deletion'),
			onClick: () => { void openSessionAction('delete'); },
		}));
		this.domNode.append(archive);

		const management = h(document, 'details', { className: 'ash-sessions-storage-management' });
		this.worktreeSummary = h(document, 'summary', {}, localize({ bundle: 'ash.sessions', key: 'sessions.storage.manageWorktrees' }, 'Manage worktrees'));
		management.append(this.worktreeSummary);
		management.append(h(document, 'p', { className: 'ash-sessions-storage-details' }, localize({ bundle: 'ash.sessions', key: 'sessions.storage.worktreeDescription' }, 'Clean worktrees from archived local sessions while keeping their conversation history.')));
		this.worktreeList = h(document, 'div', { className: 'ash-sessions-storage-worktree-list' });
		this.cleanupStatus = h(document, 'p', { className: 'ash-sessions-storage-details', attributes: { role: 'status' } });
		management.append(this.worktreeList, this.cleanupStatus);
		this.cleanupButton = this._register(new Button(management, {
			...defaultButtonStyles, presentation: 'secondary', size: 'small', enabled: false,
			label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.cleanup' }, 'Clean up selected worktrees'),
			onClick: () => { void this.cleanup(); },
		}));
		this.domNode.append(management);
		this._register(toDisposable(() => {
			this.request?.abort();
			this.domNode.remove();
		}));
	}

	protected override buildNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsSectionReference>[] {
		this.searching = !query.isEmpty;
		return [{
			element: {
				kind: 'item', id: 'sessions.storage', title: storageSettingsTitle(),
				description: localize({ bundle: 'ash.sessions', key: 'sessions.storage.search' }, 'Disk usage, worktrees and archived sessions'),
				value: this.retainElement('sessions.storage', this.domNode),
			}
		}];
	}

	setVisible(visible: boolean): void {
		if (visible && !this.searching && !this.loaded && !this.request) void this.refresh();
	}

	canClose(): boolean { return !this.cleaning; }

	private renderWorktrees(worktrees: readonly ProfileStorageWorktree[]): void {
		const document = this.domNode.ownerDocument;
		this.worktreeControls.clear();
		this.worktreeList.replaceChildren();
		if (!worktrees.length) {
			this.worktreeList.append(h(document, 'p', { className: 'ash-sessions-storage-details' }, localize({ bundle: 'ash.sessions', key: 'sessions.storage.noWorktrees' }, 'No archived local worktrees are available.')));
		}
		this.worktrees = worktrees.map(worktree => {
			const label = h(document, 'span', { className: 'ash-sessions-storage-worktree-label' },
				h(document, 'span', {}, worktree.title || worktree.path),
				h(document, 'span', { className: 'ash-sessions-storage-details' }, worktree.path));
			const size = worktree.sizeBytes === null ? localize({ bundle: 'ash.sessions', key: 'sessions.storage.unmeasured' }, 'Size unavailable') : formatStorageBytes(worktree.sizeBytes);
			const row = h(document, 'div', { className: 'ash-sessions-storage-worktree-row' });
			const checkbox = this.worktreeControls.add(new Checkbox(row, {
				...defaultCheckboxStyles, content: label,
				ariaLabel: localize({ bundle: 'ash.sessions', key: 'sessions.storage.selectWorktree' }, 'Select worktree {0} at {1}, {2}', worktree.title, worktree.path, size),
				onChange: () => this.updateCleanupButton(),
			}));
			row.append(h(document, 'span', {}, size));
			this.worktreeList.append(row);
			return { worktree, checkbox };
		});
		this.updateCleanupButton();
	}

	private updateCleanupButton(): void {
		this.cleanupButton.enabled = !this.request && !this.cleaning && this.worktrees.some(({ checkbox }) => checkbox.checked);
	}

	private async cleanup(): Promise<void> {
		const selected = this.worktrees.filter(({ checkbox }) => checkbox.checked);
		if (this.cleaning || this.request || selected.length === 0) return;
		using confirmation = new Dialog(this.domNode,
			localize({ bundle: 'ash.sessions', key: 'sessions.storage.confirmCleanup' }, 'Clean up selected worktrees?'), [
			localize({ bundle: 'ash.sessions', key: 'sessions.storage.confirmRemove' }, 'Clean up'),
			localize({ bundle: 'ash.sessions', key: 'sessions.storage.cancel' }, 'Cancel'),
		], {
			buttonStyles: defaultButtonStyles, dialogStyles: defaultDialogStyles,
			checkboxStyles: defaultCheckboxStyles, inputBoxStyles: defaultInputBoxStyles,
			type: 'warning', cancelId: 1, focusCancelButton: true,
			detail: localize({ bundle: 'ash.sessions', key: 'sessions.storage.cleanupDetail' }, 'Save open files in the selected worktrees first. Ash keeps the conversation history and skips worktrees with uncommitted changes or a changed detached HEAD. Files ignored by Git may be removed.'),
		});
		if ((await confirmation.show()).button !== 0 || this.isDisposed) return;
		this.cleaning = true;
		this.worktreeSummary.focus();
		this.refreshButton.domNode.setAttribute('aria-disabled', 'true');
		for (const { checkbox } of this.worktrees) checkbox.enabled = false;
		this.updateCleanupButton();
		this.cleanupStatus.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.cleaning' }, 'Cleaning up selected worktrees…');
		let cleaned = 0;
		for (const { worktree } of selected) {
			try {
				await this.storage.cleanWorktree(worktree);
				cleaned++;
			} catch {
				// A stale or dirty checkout must not stop cleanup of the rest of the selection.
			}
		}
		this.cleaning = false;
		if (this.isDisposed) return;
		for (const { checkbox } of this.worktrees) checkbox.enabled = true;
		this.cleanupStatus.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.cleanupResult' }, 'Cleaned up {0} of {1} selected worktrees.', cleaned, selected.length);
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (this.request || this.cleaning) return;
		const request = this.request = new AbortController();
		this.refreshButton.domNode.setAttribute('aria-disabled', 'true');
		this.updateCleanupButton();
		this.status.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.measuring' }, 'Measuring storage…');
		try {
			const overview = await this.storage.readOverview(request.signal);
			if (request.signal.aborted) return;
			const categories = [
				{ id: 'worktrees', label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.worktrees' }, 'Worktrees'), bytes: overview.worktreeBytes },
				{ id: 'sessions', label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.sessions' }, 'Session data'), bytes: overview.sessionBytes },
				{ id: 'other', label: localize({ bundle: 'ash.sessions', key: 'sessions.storage.other' }, 'Other'), bytes: overview.otherBytes },
			];
			const total = categories.reduce((bytes, category) => bytes + category.bytes, 0);
			this.total.textContent = overview.complete
				? localize({ bundle: 'ash.sessions', key: 'sessions.storage.total' }, '{0} used', formatStorageBytes(total))
				: localize({ bundle: 'ash.sessions', key: 'sessions.storage.partial' }, 'At least {0} used', formatStorageBytes(total));
			this.chart.replaceChildren();
			this.chart.hidden = total === 0;
			this.legend.replaceChildren();
			for (const { id, label, bytes } of categories) {
				const document = this.domNode.ownerDocument;
				const segment = h(document, 'span', { className: `ash-sessions-storage-${id}` });
				segment.style.flexGrow = String(bytes);
				this.chart.append(segment);
				const item = h(document, 'li', { className: `ash-sessions-storage-${id}` });
				const marker = h(document, 'span', { className: 'ash-sessions-storage-marker', attributes: { 'aria-hidden': 'true' } });
				item.append(marker, localize({ bundle: 'ash.sessions', key: 'sessions.storage.legend' }, '{0} · {1}', label, formatStorageBytes(bytes)));
				this.legend.append(item);
			}
			this.roots.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.roots' }, 'Profile at {0}\nWorktrees at {1}', overview.profileRoot, overview.worktreeRoot);
			if (overview.desktopRoot) this.roots.append('\n', localize({ bundle: 'ash.sessions', key: 'sessions.storage.desktopRoot' }, 'Desktop data at {0}', overview.desktopRoot));
			this.renderWorktrees(overview.worktrees);
			this.status.textContent = overview.complete
				? localize({ bundle: 'ash.sessions', key: 'sessions.storage.measured' }, 'Estimated file sizes. Session data includes the shared database and attachments.')
				: localize({ bundle: 'ash.sessions', key: 'sessions.storage.incomplete' }, 'Some locations could not be measured.');
			this.loaded = true;
		} catch {
			if (!request.signal.aborted) this.status.textContent = localize({ bundle: 'ash.sessions', key: 'sessions.storage.failed' }, 'Could not measure local storage. Try refreshing.');
		} finally {
			this.request = undefined;
			if (!request.signal.aborted) {
				this.refreshButton.domNode.removeAttribute('aria-disabled');
				this.updateCleanupButton();
			}
		}
	}
}

function formatStorageBytes(bytes: number): string {
	const unit = bytes >= 10 ** 9 ? 'gigabyte' : bytes >= 10 ** 6 ? 'megabyte' : bytes >= 10 ** 3 ? 'kilobyte' : 'byte';
	const divisor = { gigabyte: 10 ** 9, megabyte: 10 ** 6, kilobyte: 10 ** 3, byte: 1 }[unit];
	return new Intl.NumberFormat(undefined, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / divisor);
}
