import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

export type MemoryMetricKind = 'residentBytes' | 'javaScriptHeapBytes' | 'domNodes' | 'eventListeners' | 'uiObjects' | 'windows' | 'cacheBytes' | 'gpuEstimatedBytes' | 'gpuResources' | 'renderCacheEntries' | 'tasks';
export interface MemoryMetric {
	kind: MemoryMetricKind;
	value: number | null;
	unavailable: 'unsupported' | 'permissionDenied' | 'readFailed' | 'exited' | null;
}
export interface MemoryObservation {
	instanceId: string;
	processId: number | null;
	role: 'backend' | 'tool' | 'tui' | 'rustGui' | 'electronMain' | 'renderer' | 'gpu' | 'utility' | 'extension';
	phase: 'busy' | 'idle' | 'unknown';
	metrics: MemoryMetric[];
}
export interface MemoryDiagnosticSummary {
	readonly id: string;
	readonly status: string;
	readonly elapsedSeconds: number;
	readonly evidenceGaps: number;
	readonly targets: readonly { readonly label: string; readonly samples: number; readonly metrics: readonly string[]; readonly findings: readonly string[] }[];
}
export interface IMemoryDiagnosticsService {
	readonly onDidChange: Event<void>;
	start(): Promise<MemoryDiagnosticSummary>;
	read(): Promise<MemoryDiagnosticSummary>;
	stop(): Promise<MemoryDiagnosticSummary>;
	export(): Promise<Uint8Array>;
}
export const IMemoryDiagnosticsService = createServiceIdentifier<IMemoryDiagnosticsService>('memoryDiagnosticsService');
