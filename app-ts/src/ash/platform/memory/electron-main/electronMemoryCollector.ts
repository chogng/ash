import { getHeapStatistics } from 'node:v8';
import { app } from 'electron/main';
import type { BrowserWindow } from 'electron/main';
import type { MemoryMetric, MemoryObservation } from '../common/memoryDiagnosticsService.js';

/** Collects runtime facts for a trusted window; owns no recording or analysis state. */
export async function collectElectronMemory(window: BrowserWindow): Promise<MemoryObservation[]> {
	const processes = app.getAppMetrics();
	if (processes.length > 32) { throw new Error('Memory diagnostic process capacity exceeded.'); }
	const observations: MemoryObservation[] = processes.map(metric => ({
		instanceId: `${metric.pid}:${metric.creationTime}`,
		processId: metric.pid,
		role: metric.type === 'Browser' ? 'electronMain' : metric.type === 'Tab' ? 'renderer' : metric.type === 'GPU' ? 'gpu' : 'utility',
		phase: 'unknown',
		metrics: [{ kind: 'residentBytes', value: metric.memory.workingSetSize * 1024, unavailable: null }],
	}));
	const main = observations.find(observation => observation.processId === process.pid);
	main?.metrics.push({ kind: 'javaScriptHeapBytes', value: getHeapStatistics().used_heap_size, unavailable: null });
	if (window.isDestroyed() || window.webContents.isDestroyed()) { return observations; }
	const contents = window.webContents;
	const renderer = observations.find(observation => observation.processId === contents.getOSProcessId());
	if (!renderer) { return observations; }
	const unavailable = (reason: MemoryMetric['unavailable']): MemoryMetric[] => ['javaScriptHeapBytes', 'domNodes', 'eventListeners'].map(kind => ({ kind: kind as MemoryMetric['kind'], value: null, unavailable: reason }));
	if (contents.debugger.isAttached()) { renderer.metrics.push(...unavailable('unsupported')); return observations; }
	let timer: ReturnType<typeof setTimeout> | undefined;
	let attached = false;
	const detached = (): void => { attached = false; };
	try {
		contents.debugger.attach('1.3');
		attached = true;
		contents.debugger.once('detach', detached);
		const values = await Promise.race([
			Promise.all([contents.debugger.sendCommand('Runtime.getHeapUsage'), contents.debugger.sendCommand('Memory.getDOMCounters')]),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Memory collection timed out')), 2000); }),
		]);
		const [heap, dom] = values as [{ usedSize: number }, { nodes: number; jsEventListeners: number }];
		for (const [kind, value] of [['javaScriptHeapBytes', heap.usedSize], ['domNodes', dom.nodes], ['eventListeners', dom.jsEventListeners]] as const) {
			renderer.metrics.push(Number.isSafeInteger(value) && value >= 0 ? { kind, value, unavailable: null } : { kind, value: null, unavailable: 'readFailed' });
		}
	} catch {
		renderer.metrics.push(...unavailable(contents.isDestroyed() ? 'exited' : 'readFailed'));
	} finally {
		if (timer !== undefined) { clearTimeout(timer); }
		contents.debugger.removeListener('detach', detached);
		if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) { contents.debugger.detach(); }
	}
	return observations;
}
