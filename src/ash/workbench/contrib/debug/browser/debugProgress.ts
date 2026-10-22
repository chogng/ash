import { DeferredPromise } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import {
	IProgressService,
	ProgressLocation,
	type IProgress,
	type IProgressStep,
} from '../../../../platform/progress/common/progress.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IDebugService, type IDebugSession } from '../common/debug.js';

/** Presents adapter progress; only adapter end/session release settles its operation. */
export class DebugProgressContribution extends Disposable {
	private readonly sessions = this._register(new DisposableMap<string, DisposableStore>());

	constructor(
		@IDebugService debug: IDebugService,
		@IProgressService private readonly progress: IProgressService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		for (const session of debug.sessions) this.bind(session);
		this._register(debug.onWillNewSession((session) => this.bind(session)));
		this._register(debug.onDidEndSession((session) => this.sessions.deleteAndDispose(session.id)));
	}

	private bind(session: IDebugSession): void {
		if (this.sessions.has(session.id)) return;
		const resources = this.sessions.set(session.id, new DisposableStore());
		const jobs = new Map<
			string,
			{
				done: DeferredPromise<void>;
				reporter?: IProgress<IProgressStep>;
				percentage: number;
				reported: number;
				message?: string;
			}
		>();
		const finish = (id: string): void => {
			const job = jobs.get(id);
			if (job) {
				jobs.delete(id);
				void job.done.complete();
			}
		};
		const publish = (job: NonNullable<ReturnType<typeof jobs.get>>): void => {
			job.reporter?.report({ message: job.message, increment: job.percentage - job.reported, total: 100 });
			if (job.reporter) job.reported = job.percentage;
		};
		resources.add(
			toDisposable(() => {
				for (const id of [...jobs.keys()]) finish(id);
			}),
		);
		resources.add(
			session.onDidProgressStart((event) => {
				finish(event.progressId);
				if (jobs.size >= 16) finish(jobs.keys().next().value!);
				const job: NonNullable<ReturnType<typeof jobs.get>> = {
					done: new DeferredPromise<void>(),
					percentage: event.percentage ?? 0,
					reported: 0,
					message: event.message,
				};
				jobs.set(event.progressId, job);
				void this.progress
					.withProgress(
						{
							location: ProgressLocation.Notification,
							title: `${session.name}: ${event.title}`,
							cancellable: event.cancellable && session.capabilities.supportsCancelRequest,
							delay: 500,
						},
						async (reporter) => {
							job.reporter = reporter;
							if (!job.done.isSettled) publish(job);
							await job.done.p;
						},
						() => {
							if (jobs.get(event.progressId) !== job) return;
							void session.cancelProgress(event.progressId).catch((error) => {
								if (jobs.get(event.progressId) === job) this.notifications.error(error);
							});
						},
					)
					.catch((error) => {
						if (jobs.get(event.progressId) !== job) return;
						finish(event.progressId);
						if (!resources.isDisposed) this.notifications.error(error);
					});
			}),
		);
		resources.add(
			session.onDidProgressUpdate((event) => {
				const job = jobs.get(event.progressId);
				if (!job) return;
				if (event.percentage !== undefined) job.percentage = event.percentage;
				if (event.message !== undefined) job.message = event.message;
				publish(job);
			}),
		);
		resources.add(session.onDidProgressEnd((event) => finish(event.progressId)));
		resources.add(
			session.onDidChangeState((state) => {
				if (state === 'terminated' || state === 'error') for (const id of [...jobs.keys()]) finish(id);
			}),
		);
	}
}
