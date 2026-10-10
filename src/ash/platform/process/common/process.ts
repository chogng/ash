import type { ProcessItem } from '../../../base/common/processes.js';
import type { IRemoteDiagnosticError, PerformanceInfo, SystemInfo } from '../../diagnostics/common/diagnostics.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IProcessService = createDecorator<IProcessService>('processService');

export interface IResolvedProcessInformation {
	readonly pidToNames: [number, string][];
	readonly processes: {
		readonly name: string;
		readonly rootProcess: ProcessItem | IRemoteDiagnosticError;
	}[];
}

export interface IProcessService {
	readonly _serviceBrand: undefined;
	resolveProcesses(): Promise<IResolvedProcessInformation>;
	getSystemStatus(): Promise<string>;
	getSystemInfo(): Promise<SystemInfo>;
	getPerformanceInfo(options?: { skipCache?: boolean; unbounded?: boolean; }): Promise<PerformanceInfo>;
}
