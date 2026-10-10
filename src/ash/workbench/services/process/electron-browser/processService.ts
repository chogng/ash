import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { isRecord } from '../../../../base/common/types.js';
import type { ProcessItem } from '../../../../base/common/processes.js';
import type { PerformanceInfo, SystemInfo } from '../../../../platform/diagnostics/common/diagnostics.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IProcessService, type IResolvedProcessInformation } from '../../../../platform/process/common/process.js';

class ProcessService implements IProcessService {
	declare public readonly _serviceBrand: undefined;
	private readonly host: IProcessService;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this.host = ProxyChannel.toService<IProcessService>(mainProcessService.getChannel('process'));
	}

	public async resolveProcesses(): Promise<IResolvedProcessInformation> {
		const value: unknown = await this.host.resolveProcesses();
		if (!isRecord(value) || !Array.isArray(value.pidToNames) || !Array.isArray(value.processes)) { throw new TypeError('Invalid process diagnostics'); }
		for (const entry of value.pidToNames) {
			if (!Array.isArray(entry) || entry.length !== 2 || !Number.isSafeInteger(entry[0]) || entry[0] <= 0 || typeof entry[1] !== 'string') { throw new TypeError('Invalid process name'); }
		}
		for (const group of value.processes) {
			if (!isRecord(group) || typeof group.name !== 'string') { throw new TypeError('Invalid process group'); }
			if (isRecord(group.rootProcess) && typeof group.rootProcess.hostName === 'string' && typeof group.rootProcess.errorMessage === 'string') { continue; }
			validateProcess(group.rootProcess);
		}
		return value as unknown as IResolvedProcessInformation;
	}

	public async getSystemStatus(): Promise<string> {
		const value: unknown = await this.host.getSystemStatus();
		if (typeof value !== 'string') { throw new TypeError('Invalid system status'); }
		return value;
	}

	public async getSystemInfo(): Promise<SystemInfo> {
		const value: unknown = await this.host.getSystemInfo();
		if (!isRecord(value)) { throw new TypeError('Invalid Desktop system diagnostics'); }
		const hasStrings = ['os', 'memory', 'vmHint', 'processArgs', 'screenReader'].every(key => typeof value[key] === 'string');
		const hasOptionalStrings = ['cpus', 'load'].every(key => value[key] === undefined || typeof value[key] === 'string');
		const hasGpuStatus = isRecord(value.gpuStatus) && Object.values(value.gpuStatus).every(status => typeof status === 'string');
		// This channel represents only the local host; App Server facts have their own owner.
		if (!hasStrings || !hasOptionalStrings || !hasGpuStatus || !Array.isArray(value.remoteData) || value.remoteData.length !== 0) {
			throw new TypeError('Invalid Desktop system diagnostics');
		}
		return value as unknown as SystemInfo;
	}

	public async getPerformanceInfo(options?: { skipCache?: boolean; unbounded?: boolean; }): Promise<PerformanceInfo> {
		const value: unknown = await (options === undefined ? this.host.getPerformanceInfo() : this.host.getPerformanceInfo(options));
		if (!isRecord(value) || ['processInfo', 'workspaceInfo'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) { throw new TypeError('Invalid performance diagnostics'); }
		return value as PerformanceInfo;
	}
}

function validateProcess(value: unknown): asserts value is ProcessItem {
	const pending = [value];
	for (const item of pending) {
		if (!isRecord(item) || typeof item.name !== 'string' || typeof item.cmd !== 'string') { throw new TypeError('Invalid process snapshot'); }
		const hasIds = Number.isSafeInteger(item.pid) && (item.pid as number) > 0 && Number.isSafeInteger(item.ppid) && (item.ppid as number) >= 0;
		const hasMetrics = typeof item.load === 'number' && Number.isFinite(item.load) && item.load >= 0 && Number.isSafeInteger(item.mem) && (item.mem as number) >= 0;
		if (!hasIds || !hasMetrics || item.children !== undefined && !Array.isArray(item.children)) { throw new TypeError('Invalid process snapshot'); }
		if (Array.isArray(item.children)) { pending.push(...item.children); }
	}
}

registerSingleton(IProcessService, ProcessService, InstantiationType.Delayed);
