import type { Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IProcessDataEvent } from './terminal.js';

interface BufferedProcess {
	readonly lifetime: DisposableStore;
	readonly chunks: string[];
	timer: ReturnType<typeof setTimeout> | undefined;
}

/** Batches transport-facing text. Renderer parsing and its commit promises remain with the consumer. */
export class TerminalDataBufferer extends Disposable {
	private readonly processes = new Map<number, BufferedProcess>();

	constructor(private readonly callback: (id: number, data: string) => void) {
		super();
	}

	startBuffering(id: number, event: Event<string | IProcessDataEvent>, throttleBy = 5): IDisposable {
		this.assertNotDisposed();
		this.stopBuffering(id);
		const process: BufferedProcess = { lifetime: new DisposableStore(), chunks: [], timer: undefined };
		this.processes.set(id, process);
		process.lifetime.add(
			event(data => {
				if (this.processes.get(id) !== process) return;
				process.chunks.push(typeof data === 'string' ? data : data.data);
				if (process.timer === undefined) process.timer = setTimeout(() => this.flushBuffer(id), throttleBy);
			}),
		);
		return toDisposable(() => {
			if (this.processes.get(id) === process) this.stopBuffering(id);
		});
	}

	flushBuffer(id: number): void {
		const process = this.processes.get(id);
		if (!process) return;
		clearTimeout(process.timer);
		process.timer = undefined;
		if (!process.chunks.length) return;
		const data = process.chunks.join('');
		process.chunks.length = 0;
		this.callback(id, data);
	}

	stopBuffering(id: number): void {
		const process = this.processes.get(id);
		if (!process) return;
		try {
			this.flushBuffer(id);
		} finally {
			if (this.processes.get(id) === process) this.processes.delete(id);
			process.lifetime.dispose();
		}
	}

	protected override disposeCore(): void {
		for (const id of [...this.processes.keys()]) this.stopBuffering(id);
		super.disposeCore();
	}
}
