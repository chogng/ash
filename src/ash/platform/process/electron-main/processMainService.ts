import { arch, freemem, loadavg, release, totalmem, type } from 'node:os';
import { Worker } from 'node:worker_threads';
import { app, BrowserWindow } from 'electron/main';
import { listProcesses } from '../../../base/node/ps.js';
import { localize } from '../../../nls.js';
import type { PerformanceInfo, SystemInfo } from '../../diagnostics/common/diagnostics.js';
import type { IProcessService, IResolvedProcessInformation } from '../common/process.js';
import { isRecord } from '../../../base/common/types.js';
import { IGPUProcessMainService } from '../../gpu/electron-main/gpuProcessMainService.js';

/** The Desktop host owns local machine facts; remote facts remain App Server-owned. */
export class ProcessMainService implements IProcessService {
	declare public readonly _serviceBrand: undefined;
	private cpuInfo: Promise<string | undefined> | undefined;

	constructor(@IGPUProcessMainService private readonly gpuProcessMainService: IGPUProcessMainService) {}

	public async getSystemInfo(): Promise<SystemInfo> {
		const cpus = await this.readCpuInfo();
		return {
			os: `${type()} ${arch()} ${release()}`,
			cpus,
			memory: localize('diagnostics.memory', '{0} GiB ({1} GiB free)', (totalmem() / 2 ** 30).toFixed(2), (freemem() / 2 ** 30).toFixed(2)),
			vmHint: localize('issue.diagnosticsUnavailable', 'Unavailable'),
			// Launch arguments are unnecessary for this report and can contain user data.
			processArgs: '',
			gpuStatus: { ...this.gpuProcessMainService.featureStatus },
			screenReader: app.isAccessibilitySupportEnabled() ? 'yes' : 'no',
			remoteData: [],
			load:
				process.platform === 'win32'
					? undefined
					: loadavg()
							.map(value => value.toFixed(2))
							.join(', '),
		};
	}

	private readCpuInfo(): Promise<string | undefined> {
		// Linux frequency reads can block for seconds. Keep the full diagnostic snapshot
		// off the main thread, sharing only in-flight work so later reports get fresh data.
		this.cpuInfo ??= new Promise<string | undefined>(resolve => {
			try {
				const worker = new Worker(
					`
					const { cpus } = require('node:os');
					const { parentPort } = require('node:worker_threads');
					const processors = cpus();
					parentPort.postMessage(processors.length
						? processors[0].model + ' (' + processors.length + ' × ' + processors[0].speed + ' MHz)'
						: undefined);
				`,
					{ eval: true, execArgv: [], name: 'ash-cpu-diagnostics' },
				);
				let result: string | undefined;
				worker.once('message', (value: unknown) => {
					result = typeof value === 'string' ? value : undefined;
				});
				worker.once('error', () => resolve(undefined));
				// Waiting for exit also releases the one-shot worker before starting another sample.
				worker.once('exit', code => resolve(code === 0 ? result : undefined));
				worker.unref();
			} catch {
				// CPU collection is optional; never fall back to blocking the main thread.
				resolve(undefined);
			}
		}).finally(() => {
			this.cpuInfo = undefined;
		});
		return this.cpuInfo;
	}

	public async resolveProcesses(): Promise<IResolvedProcessInformation> {
		const rootProcess = await listProcesses(process.pid);
		const names = new Map<number, string>([[process.pid, localize('diagnostics.mainProcess', 'Ash Main')]]);
		for (const metric of app.getAppMetrics()) {
			if (metric.pid !== process.pid) {
				names.set(metric.pid, metric.name || metric.type);
			}
		}
		for (const window of BrowserWindow.getAllWindows()) {
			if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
				names.set(window.webContents.getOSProcessId(), localize('diagnostics.renderer', 'Renderer: {0}', window.getTitle()));
			}
		}
		return {
			pidToNames: [...names],
			processes: [{ name: localize('diagnostics.desktop', 'Desktop'), rootProcess }],
		};
	}

	public async getPerformanceInfo(options?: { skipCache?: boolean; unbounded?: boolean }): Promise<PerformanceInfo> {
		if (options !== undefined) {
			if (!isRecord(options)) {
				throw new TypeError('Invalid performance diagnostic options');
			}
			const hasUnknownKeys = Object.keys(options).some(key => key !== 'skipCache' && key !== 'unbounded');
			if (hasUnknownKeys || Object.values(options).some(value => typeof value !== 'boolean')) {
				throw new TypeError('Invalid performance diagnostic options');
			}
		}
		// Every request takes a fresh host snapshot. Workspace scans are not part of this collection.
		const snapshot = await this.resolveProcesses();
		const names = new Map(snapshot.pidToNames);
		const lines = [localize('diagnostics.processHeader', 'PID\tCPU %\tRSS MiB\tProcess')];
		for (const group of snapshot.processes) {
			if ('errorMessage' in group.rootProcess) {
				lines.push(`${group.name}: ${group.rootProcess.errorMessage}`);
				continue;
			}
			const pending = [group.rootProcess];
			for (const item of pending) {
				lines.push(`${item.pid}\t${item.load.toFixed(1)}\t${(item.mem / 2 ** 20).toFixed(1)}\t${names.get(item.pid) ?? item.name}`);
				pending.push(...(item.children ?? []));
			}
		}
		return { processInfo: lines.join('\n') };
	}

	public async getSystemStatus(): Promise<string> {
		const [system, performance] = await Promise.all([this.getSystemInfo(), this.getPerformanceInfo()]);
		return `${system.os}\n${system.cpus ?? ''}\n${system.memory}\n\n${performance.processInfo ?? ''}`;
	}
}
