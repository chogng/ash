import { APP_SERVER_METHODS } from '../../app-server/common/generated/index.js';
import type { MemoryReport } from '../../app-server/common/generated/index.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { Emitter } from '../../../base/common/event.js';
import { generateUuid } from '../../../base/common/uuid.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import type { IMemoryDiagnosticsService, MemoryDiagnosticSummary, MemoryObservation } from '../common/memoryDiagnosticsService.js';

export class AppServerMemoryDiagnosticsService extends Disposable implements IMemoryDiagnosticsService {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private sessionId: string | undefined;
	private generation = 0;
	private connectionGeneration = 0;
	private sequence = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private sampling: Promise<void> | undefined;
	private starting: Promise<MemoryDiagnosticSummary> | undefined;
	private failure: unknown;
	private mutation: Promise<void> = Promise.resolve();

	constructor(private readonly client: AppServerProtocolClient, private readonly product: 'electron' | 'browser', private readonly collect: () => Promise<MemoryObservation[]>) {
		super();
		this._register(client.onStateChange(state => {
			if (state !== 'ready') { this.connectionGeneration++; this.invalidate(); this.sessionId = undefined; this.failure = new Error('Memory diagnostics were interrupted by a backend connection change.'); this.changed.fire(); }
		}));
		this._register(toDisposable(() => {
			const sessionId = this.sessionId;
			this.invalidate();
			if (sessionId && client.state === 'ready') { void client.request(APP_SERVER_METHODS['memoryDiagnostics/stop'], { sessionId }).catch(error => console.warn('Memory diagnostic cleanup failed', error)); }
		}));
	}

	public start(): Promise<MemoryDiagnosticSummary> {
		this.assertNotDisposed();
		if (this.starting) { return this.starting; }
		const operation = this.mutation.then(() => this.begin());
		this.mutation = operation.then(() => undefined, () => undefined);
		this.starting = operation;
		void operation.finally(() => { if (this.starting === operation) { this.starting = undefined; } }).catch(() => {});
		return operation;
	}

	private async begin(): Promise<MemoryDiagnosticSummary> {
		this.assertNotDisposed();
		if (this.sessionId) {
			const report = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/read'], { sessionId: this.sessionId });
			this.assertNotDisposed();
			if (report.status === 'recording') {
				if (this.failure) { this.invalidate(); this.failure = undefined; this.schedule(this.generation, report.sampleIntervalMs, 0); }
				return summarize(report);
			}
		}
		this.invalidate();
		const generation = this.generation;
		const connectionGeneration = this.connectionGeneration;
		const report = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/start'], { requestId: generateUuid(), product: this.product, durationSecs: 1800 });
		if (generation !== this.generation) {
			if (connectionGeneration === this.connectionGeneration && this.client.state === 'ready') { await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/stop'], { sessionId: report.sessionId }); }
			throw new Error('Memory diagnostic connection changed while starting.');
		}
		this.sessionId = report.sessionId;
		this.failure = undefined;
		this.sequence = 0;
		this.schedule(generation, report.sampleIntervalMs, 0);
		this.changed.fire();
		return summarize(report);
	}

	public async read(): Promise<MemoryDiagnosticSummary> {
		this.assertNotDisposed();
		if (this.failure) { throw this.failure; }
		return summarize(await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/read'], { sessionId: this.requireSession() }));
	}

	public stop(): Promise<MemoryDiagnosticSummary> {
		const operation = this.mutation.then(() => this.end());
		this.mutation = operation.then(() => undefined, () => undefined);
		return operation;
	}

	private async end(): Promise<MemoryDiagnosticSummary> {
		this.assertNotDisposed();
		const sessionId = this.requireSession();
		this.invalidate();
		const generation = this.generation;
		// A failed collector must not prevent the explicit backend stop.
		await this.sampling?.catch(() => undefined);
		if (generation !== this.generation) { throw new Error('Memory diagnostic connection changed while stopping.'); }
		const report = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/stop'], { sessionId });
		this.failure = undefined;
		this.changed.fire();
		return summarize(report);
	}

	public async export(): Promise<Uint8Array> {
		this.assertNotDisposed();
		const connectionGeneration = this.connectionGeneration;
		const metadata = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/export'], { sessionId: this.requireSession() });
		try {
			this.assertNotDisposed();
			if (connectionGeneration !== this.connectionGeneration) { throw new Error('Memory diagnostic connection changed during export.'); }
			if (metadata.size > 16 * 1024 * 1024) { throw new Error('Memory diagnostic report exceeds the resource limit.'); }
			const bytes = new Uint8Array(metadata.size);
			let offset = 0;
			while (offset < bytes.length) {
				const chunk = await this.client.request(APP_SERVER_METHODS['resource/read'], { resourceId: metadata.resourceId, offset, maxBytes: 262144 });
				this.assertNotDisposed();
				if (connectionGeneration !== this.connectionGeneration) { throw new Error('Memory diagnostic connection changed during export.'); }
				const decoded = Uint8Array.from(atob(chunk.dataBase64), character => character.charCodeAt(0));
				if (chunk.offset !== offset || decoded.length === 0 || decoded.length !== chunk.decodedLength || offset + decoded.length > bytes.length) { throw new Error('Invalid memory report chunk.'); }
				bytes.set(decoded, offset);
				offset += decoded.length;
			}
			return bytes;
		} finally {
			if (connectionGeneration === this.connectionGeneration && this.client.state === 'ready') { await this.client.request(APP_SERVER_METHODS['resource/release'], { resourceId: metadata.resourceId }); }
		}
	}

	private requireSession(): string {
		if (!this.sessionId) { throw new Error('Start memory diagnostics first.'); }
		return this.sessionId;
	}

	private schedule(generation: number, interval: number, delay: number): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const task = this.sample(generation, interval);
			this.sampling = task;
			void task.catch(error => { if (generation === this.generation) { this.failure = error; this.changed.fire(); } }).finally(() => { if (this.sampling === task) { this.sampling = undefined; } });
		}, delay);
	}

	private async sample(generation: number, interval: number): Promise<void> {
		const sessionId = this.requireSession();
		const before = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/read'], { sessionId });
		if (generation !== this.generation) { return; }
		if (before.status !== 'recording') { this.changed.fire(); return; }
		const observations = await this.collect();
		if (generation !== this.generation) { return; }
		await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/submit'], { sessionId, sequence: ++this.sequence, observations });
		if (generation !== this.generation) { return; }
		const report = await this.client.request(APP_SERVER_METHODS['memoryDiagnostics/read'], { sessionId });
		if (generation !== this.generation) { return; }
		this.changed.fire();
		if (report.status === 'recording') { this.schedule(generation, interval, interval); }
	}

	private invalidate(): void {
		this.generation++;
		if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined; }
	}
}

function summarize(report: MemoryReport): MemoryDiagnosticSummary {
	return { id: report.sessionId, status: words(report.status), elapsedSeconds: Math.floor(report.elapsedMs / 1000), evidenceGaps: report.evidenceGaps, targets: report.targets.map(target => ({ label: `${words(target.origin)} / ${words(target.role)} / PID ${target.processId ?? 'unavailable'}`, samples: target.samples, metrics: target.latest.metrics.map(metric => `${words(metric.kind)}: ${metric.value === null ? words(metric.unavailable ?? 'unavailable') : metric.value.toLocaleString('en-US')}`), findings: target.trends.map(trend => `${words(trend.kind)}: ${words(trend.finding)}`) })) };
}

function words(value: string): string {
	return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}
