import type { ProgressBar } from '../../../../base/browser/ui/progressbar/progressbar.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IProgressIndicator, IProgressRunner } from '../../../../platform/progress/common/progress.js';

export interface IProgressScope {
	readonly onDidChangeActive: Event<void>;
	readonly isActive: boolean;
}

interface PendingProgress {
	total: number | undefined;
	worked: number;
	ready: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** Retains presentation while a view is hidden, without owning the underlying task. */
export class ScopedProgressIndicator extends Disposable implements IProgressIndicator {
	private readonly pending = new Set<PendingProgress>();

	constructor(
		private readonly progressBar: ProgressBar,
		private readonly scope: IProgressScope,
	) {
		super();
		this.progressBar.element.hidden = true;
		this._register(scope.onDidChangeActive(() => this.render()));
	}

	show(infinite: true, delay?: number): IProgressRunner;
	show(total: number, delay?: number): IProgressRunner;
	show(infiniteOrTotal: true | number, delay = 0): IProgressRunner {
		this.assertNotDisposed();
		const pending: PendingProgress = {
			total: infiniteOrTotal === true ? undefined : infiniteOrTotal,
			worked: 0,
			ready: delay <= 0,
		};
		this.pending.add(pending);
		if (!pending.ready) {
			pending.timer = setTimeout(() => {
				pending.timer = undefined;
				pending.ready = true;
				this.render();
			}, delay);
		}
		this.render();
		return {
			total: value => {
				if (!this.pending.has(pending)) return;
				pending.total = value;
				this.render();
			},
			worked: value => {
				if (!this.pending.has(pending)) return;
				pending.worked += value;
				this.render();
			},
			done: () => {
				if (!this.pending.delete(pending)) return;
				clearTimeout(pending.timer);
				this.render();
			},
		};
	}

	async showWhile(promise: Promise<unknown>, delay?: number): Promise<void> {
		const runner = this.show(true, delay);
		try {
			await promise;
		} catch {
			// Presentation completes on either outcome; the producer handles errors.
		} finally {
			runner.done();
		}
	}

	private render(): void {
		const current = [...this.pending].filter(pending => pending.ready).at(-1);
		this.progressBar.element.hidden = !this.scope.isActive || !current;
		if (current) {
			this.progressBar.value = current.total === undefined ? undefined : current.worked / Math.max(1, current.total);
		}
	}

	protected override disposeCore(): void {
		for (const pending of this.pending) clearTimeout(pending.timer);
		this.pending.clear();
		this.progressBar.element.hidden = true;
		super.disposeCore();
	}
}
