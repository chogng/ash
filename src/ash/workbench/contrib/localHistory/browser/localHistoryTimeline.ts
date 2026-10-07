import { throwIfCancelled, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITimelineService, type Timeline, type TimelineChangeEvent, type TimelineOptions, type TimelineProvider } from '../../timeline/common/timeline.js';
import { IWorkingCopyHistoryService } from '../../../services/workingCopy/common/workingCopyHistory.js';

/** Publishes the existing saved snapshots without introducing another history store. */
export class LocalHistoryTimeline extends Disposable implements TimelineProvider {
	public static readonly ID = 'workbench.contrib.localHistoryTimeline';
	public readonly id = 'timeline.localHistory';
	public readonly label = localize('timeline.localHistory', 'Local History');
	public readonly scheme = '*';
	private readonly changed = this._register(new Emitter<TimelineChangeEvent>());
	public readonly onDidChange = this.changed.event;
	private readonly registration = this._register(new MutableDisposable());

	constructor(
		@ITimelineService timeline: ITimelineService,
		@IWorkingCopyHistoryService private readonly history: IWorkingCopyHistoryService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const update = (): void => {
			this.registration.clear();
			if (configuration.getValue<boolean>('workbench.localHistory.enabled')) this.registration.value = timeline.registerTimelineProvider(this);
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('workbench.localHistory.enabled')) update();
		}));
		this._register(history.onDidAddEntry(({ entry }) => this.changed.fire({ id: this.id, uri: entry.workingCopy.resource, reset: true })));
		update();
	}

	public async provideTimeline(uri: URI, options: TimelineOptions, token: CancellationToken): Promise<Timeline> {
		const entries = await this.history.getEntries(uri, token);
		throwIfCancelled(token);
		const start = options.cursor === undefined ? 0 : entries.findIndex(entry => entry.id === options.cursor) + 1;
		const limit = typeof options.limit === 'number' ? options.limit : entries.length;
		const page = options.cursor !== undefined && start === 0 ? [] : entries.slice(start, start + limit);
		return {
			source: this.id,
			items: page.map(entry => ({
				id: entry.id, handle: entry.id, source: this.id,
				label: localize('timeline.localHistory.saved', 'File Saved'),
				description: new Date(entry.timestamp).toLocaleString(),
				timestamp: entry.timestamp,
				tooltip: localize('timeline.localHistory.entry', '{0} — {1}', entry.workingCopy.name, new Date(entry.timestamp).toLocaleString()),
				command: { id: 'workbench.action.localHistory.open', title: localize('timeline.localHistory.compare', 'Compare with File'), arguments: [uri, entry.id] },
			})),
			paging: { cursor: start + page.length < entries.length ? page.at(-1)?.id : undefined },
		};
	}
}
