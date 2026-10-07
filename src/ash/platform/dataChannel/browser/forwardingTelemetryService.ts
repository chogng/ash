import type { ClassifiedEvent, IGDPRProperty, OmitMetadata, StrictPropertyCheck } from '../../telemetry/common/gdprTypings.js';
import { ITelemetryService, type ITelemetryData, type TelemetryLevel } from '../../telemetry/common/telemetry.js';
import { IDataChannelService } from '../common/dataChannel.js';

export class InterceptingTelemetryService implements ITelemetryService {
	public readonly _serviceBrand = undefined;

	constructor(private readonly baseService: ITelemetryService, private readonly intercept: (eventName: string, data?: ITelemetryData) => void) { }

	public get telemetryLevel(): TelemetryLevel { return this.baseService.telemetryLevel; }
	public get sessionId(): string { return this.baseService.sessionId; }
	public get machineId(): string { return this.baseService.machineId; }
	public get sqmId(): string { return this.baseService.sqmId; }
	public get devDeviceId(): string { return this.baseService.devDeviceId; }
	public get firstSessionDate(): string { return this.baseService.firstSessionDate; }
	public get msftInternal(): boolean | undefined { return this.baseService.msftInternal; }
	public get sendErrorTelemetry(): boolean { return this.baseService.sendErrorTelemetry; }

	public publicLog(eventName: string, data?: ITelemetryData): void {
		this.intercept(eventName, data);
		this.baseService.publicLog(eventName, data);
	}

	public publicLog2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>): void {
		this.intercept(eventName, data);
		this.baseService.publicLog2<E, T>(eventName, data);
	}

	public publicLogError(eventName: string, data?: ITelemetryData): void {
		this.intercept(eventName, data);
		this.baseService.publicLogError(eventName, data);
	}

	public publicLogError2<E extends ClassifiedEvent<OmitMetadata<T>> = never, T extends IGDPRProperty = never>(eventName: string, data?: StrictPropertyCheck<T, E>): void {
		this.intercept(eventName, data);
		this.baseService.publicLogError2<E, T>(eventName, data);
	}

	public setExperimentProperty(name: string, value: string): void {
		this.baseService.setExperimentProperty(name, value);
	}

	public setCommonProperty(name: string, value: string | boolean | undefined): void {
		this.baseService.setCommonProperty(name, value);
	}
}

export interface IEditTelemetryData {
	eventName: string;
	data: Record<string, unknown>;
}

const channelForwarding = Symbol('channelForwarding');

export function forwardToChannelIf(value: boolean): Record<string, unknown> {
	return { [channelForwarding]: value };
}

export function isCopilotLikeExtension(extensionId: string | undefined): boolean {
	const id = extensionId?.toLowerCase();
	return id === 'github.copilot' || id === 'github.copilot-chat';
}

export class DataChannelForwardingTelemetryService extends InterceptingTelemetryService {
	constructor(@ITelemetryService telemetryService: ITelemetryService, @IDataChannelService dataChannelService: IDataChannelService) {
		const channel = dataChannelService.getDataChannel<IEditTelemetryData>('editTelemetry');
		super(telemetryService, (eventName, data) => {
			if (data && (data as Record<symbol, unknown>)[channelForwarding] === false) {
				return;
			}
			// Symbols control local routing and must never cross the extension transport.
			channel.sendData({ eventName, data: Object.fromEntries(Object.entries(data ?? {})) });
		});
	}
}
