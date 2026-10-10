import type { ProcessItem } from '../../../base/common/processes.js';

export interface IMachineInfo {
	os: string;
	cpus?: string;
	memory: string;
	vmHint: string;
}

export interface IRemoteDiagnosticInfo {
	hostName: string;
	machineInfo: IMachineInfo;
	processes?: ProcessItem;
}

export interface IRemoteDiagnosticError {
	hostName: string;
	errorMessage: string;
}

export interface SystemInfo extends IMachineInfo {
	processArgs: string;
	gpuStatus: Record<string, string>;
	screenReader: string;
	remoteData: (IRemoteDiagnosticInfo | IRemoteDiagnosticError)[];
	load?: string;
}

export interface PerformanceInfo {
	processInfo?: string;
	workspaceInfo?: string;
}
