import { localize } from '../../../../nls.js';
import { IIssueReporterService, type IssueReporterContext } from '../../../../platform/issue/common/issue.js';
import { IProcessService } from '../../../../platform/process/common/process.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IssueFormService } from '../browser/issueFormService.js';

/** Adds Desktop host diagnostics to the shared report draft and submission lifecycle. */
export class IssueReporterService extends IssueFormService {
	constructor(
		@IIssueReporterService backend: IIssueReporterService,
		@IExtensionService extensions: IExtensionService,
		@IProcessService private readonly processes: IProcessService,
	) { super(backend, extensions); }

	protected override async readSystemInfo(context: IssueReporterContext): Promise<string> {
		const sections = [await super.readSystemInfo(context)];
		try {
			const system = await this.processes.getSystemInfo();
			const screenReader = system.screenReader === 'yes' ? localize('issue.screenReaderEnabled', 'Enabled') : localize('issue.screenReaderDisabled', 'Disabled');
			sections.unshift(localize('issue.desktopSystem', 'Desktop\nOS: {0}\nCPU: {1}\nMemory: {2}\nGPU: {3}\nScreen reader: {4}',
				system.os,
				system.cpus ?? localize('issue.diagnosticsUnavailable', 'Unavailable'),
				system.memory,
				JSON.stringify(system.gpuStatus),
				screenReader,
			));
		} catch {
			sections.unshift(localize('issue.desktopDiagnosticsFailed', 'Desktop system diagnostics could not be collected.'));
		}
		try {
			const performance = await this.processes.getPerformanceInfo();
			if (performance.processInfo) { sections.push(localize('issue.desktopProcesses', 'Desktop processes\n{0}', performance.processInfo)); }
		} catch { sections.push(localize('issue.processDiagnosticsFailed', 'Desktop process diagnostics could not be collected.')); }
		return sections.join('\n\n');
	}
}
