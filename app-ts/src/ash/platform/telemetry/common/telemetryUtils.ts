import { type ITelemetryData, type ITelemetryService, TelemetryLevel } from './telemetry.js';
import type { ClassifiedEvent, IGDPRProperty, OmitMetadata, StrictPropertyCheck } from './gdprTypings.js';

/** Product composition explicitly selects no collection; extension data forwarding is independent. */
export class NullTelemetryServiceShape implements ITelemetryService {
	public readonly _serviceBrand = undefined;
	public readonly telemetryLevel = TelemetryLevel.NONE;
	public readonly sessionId = '';
	public readonly machineId = '';
	public readonly sqmId = '';
	public readonly devDeviceId = '';
	public readonly firstSessionDate = '';
	public readonly sendErrorTelemetry = false;
	public publicLog(_eventName: string, _data?: ITelemetryData): void {}
	public publicLog2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(_eventName: string, _data?: StrictPropertyCheck<T, E>): void {}
	public publicLogError(_eventName: string, _data?: ITelemetryData): void {}
	public publicLogError2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(_eventName: string, _data?: StrictPropertyCheck<T, E>): void {}
	public setExperimentProperty(_name: string, _value: string): void {}
	public setCommonProperty(_name: string, _value: string | boolean | undefined): void {}
}

export const NullTelemetryService = new NullTelemetryServiceShape();
