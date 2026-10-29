import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import './media/chatChangesPill.css';
import { h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import type { ChatChangesStatistics } from './chatInput.js';
import { RunOnceScheduler } from '../../../../../../base/common/async.js';
import { derived, observableValue } from '../../../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ChangesStatsWidget, getChangesStatsFilesLabel } from '../../../../../browser/changesStatsWidget.js';

/** Presents conversation snapshots and polls the optional Git provider while New Chat is visible. */
export class ChatChangesPill extends Disposable {
	readonly domNode: HTMLDivElement;
	private readonly button: Button;
	private readonly counts: HTMLSpanElement;
	private scope: 'workspace' | 'conversation' = 'conversation';
	private readonly statistics = observableValue<ChatChangesStatistics | undefined>(this, undefined);
	private error: string | undefined;
	private enabled = false;
	private visible = true;
	private generation = 0;
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.loadWorkspace(), 5000));

	constructor(
		container: HTMLElement,
		openChanges: () => void,
		private readonly focusInput: () => void,
		private readonly readWorkspace: (() => Promise<ChatChangesStatistics | undefined>) | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div', { className: 'ash-chat-input-changes' });
		this.domNode.hidden = true;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.button = this._register(
			new Button(this.domNode, {
				...defaultButtonStyles,
				label: '',
				icon: Lxicon.diff,
				onClick: openChanges,
			}),
		);
		this.button.domNode.classList.add('ash-chat-changes-pill');
		this.counts = h(container.ownerDocument, 'span', { className: 'ash-chat-changes-statistics' });
		this.counts.setAttribute('aria-hidden', 'true');
		this.button.domNode.append(this.counts);
		this._register(
			instantiationService.createInstance(
				ChangesStatsWidget,
				this.counts,
				derived(reader => {
					const statistics = this.statistics.read(reader);
					return statistics ? { files: statistics.files, insertions: statistics.additions, deletions: statistics.deletions } : undefined;
				}),
				false,
			),
		);
		this._register(
			toDisposable(() => {
				this.generation++;
			}),
		);
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.generation++;
		this.refresh.cancel();
		if (visible && this.scope === 'workspace') this.refresh.schedule(0);
	}

	render(statistics: ChatChangesStatistics | undefined, enabled: boolean, scope: 'workspace' | 'conversation' = 'conversation', error?: string): void {
		this.enabled = enabled;
		if (scope !== this.scope) {
			this.generation++;
			this.scope = scope;
			this.statistics.set(undefined);
			this.error = undefined;
			this.refresh.cancel();
			if (scope === 'workspace' && this.visible) this.refresh.schedule(0);
		}
		if (scope === 'conversation') {
			this.statistics.set(statistics);
			this.error = error;
		}
		this.renderCurrent();
	}

	private async loadWorkspace(): Promise<void> {
		if (!this.readWorkspace || !this.visible || this.scope !== 'workspace') return;
		const generation = this.generation;
		try {
			const statistics = await this.readWorkspace();
			if (this.isDisposed || generation !== this.generation) return;
			this.statistics.set(statistics);
			this.error = undefined;
		} catch {
			if (this.isDisposed || generation !== this.generation) return;
			this.statistics.set(undefined);
			this.error = localize('chat.changes.loadFailed', 'Changes are unavailable. Open Changes to retry.');
		}
		this.renderCurrent();
		this.refresh.schedule();
	}

	private renderCurrent(): void {
		const statistics = this.statistics.get();
		// Only confirmed file changes belong in the composer summary.
		const visible = this.enabled && !this.error && statistics !== undefined && statistics.files > 0;
		if (!visible && this.domNode.contains(this.domNode.ownerDocument.activeElement)) {
			this.focusInput();
		}
		this.domNode.hidden = !visible;
		if (!visible || !statistics) return;
		this.counts.classList.toggle('partial', statistics?.partial === true);
		this.button.label = getChangesStatsFilesLabel(statistics.files);
		let label =
			this.scope === 'workspace'
				? localize('chat.changes.openWorkspace', 'Open Workspace Changes: {0} files, {1} lines added, {2} lines removed', statistics.files, statistics.additions, statistics.deletions)
				: localize('chat.changes.openConversation', 'Open Conversation Changes: {0} files, {1} lines added, {2} lines removed', statistics.files, statistics.additions, statistics.deletions);
		if (statistics.partial) label = localize('chat.changes.partialStatistics', '{0}. Line counts exclude files that cannot be compared as text.', label);
		if (this.button.domNode.getAttribute('aria-label') !== label) {
			this.button.domNode.setAttribute('aria-label', label);
			this.button.setTitle(label);
		}
	}
}
