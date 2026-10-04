import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { ClassifiedEvent, IGDPRProperty, OmitMetadata, StrictPropertyCheck } from './gdprTypings.js';

export const ITelemetryService = createDecorator<ITelemetryService>('telemetryService');

export const enum TelemetryLevel {
	NONE = 0,
	CRASH = 1,
	ERROR = 2,
	USAGE = 3,
}

export interface ITelemetryData {
	[key: string]: unknown;
}

export interface ITelemetryService {
	readonly _serviceBrand: undefined;
	readonly telemetryLevel: TelemetryLevel;
	readonly sessionId: string;
	readonly machineId: string;
	readonly sqmId: string;
	readonly devDeviceId: string;
	readonly firstSessionDate: string;
	readonly msftInternal?: boolean;
	readonly sendErrorTelemetry: boolean;
	publicLog(eventName: string, data?: ITelemetryData): void;
	publicLog2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>): void;
	publicLogError(eventName: string, data?: ITelemetryData): void;
	publicLogError2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>): void;
	setExperimentProperty(name: string, value: string): void;
	setCommonProperty(name: string, value: string | boolean | undefined): void;
}
