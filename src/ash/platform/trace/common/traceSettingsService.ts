import type { Event } from '../../../base/common/event.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface TraceSettings {
	readonly enabled: boolean;
	readonly directory: string | null;
}

export type TraceRecordingState =
	| { readonly type: 'disabled'; }
	| { readonly type: 'enabled'; readonly directory: string; }
	| { readonly type: 'unavailable'; readonly directory: string; readonly error: string; };

export interface TraceSettingsSnapshot {
	readonly revision: number;
	readonly configured: TraceSettings | null;
	readonly recording: TraceRecordingState;
}

/** Profile-wide diagnostic intent; the backend recorder applies it at startup. */
export interface ITraceSettingsService {
	readonly onDidChange: Event<void>;
	read(): Promise<TraceSettingsSnapshot>;
	configure(settings: TraceSettings, expectedRevision: number): Promise<void>;
}

export const ITraceSettingsService = createServiceIdentifier<ITraceSettingsService>('traceSettingsService');
