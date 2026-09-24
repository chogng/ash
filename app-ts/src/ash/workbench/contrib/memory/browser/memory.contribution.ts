import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IMemoryDiagnosticsService } from '../../../../platform/memory/common/memoryDiagnosticsService.js';
import type { MemoryDiagnosticSummary } from '../../../../platform/memory/common/memoryDiagnosticsService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { triggerDownload } from '../../../../base/browser/fileAccess.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';

function describe(report: MemoryDiagnosticSummary): string {
	return [`Memory diagnostics: ${report.status} · ${report.elapsedSeconds}s`, 'Growth is evidence for investigation, not proof of a leak.', ...report.targets.map(target => `${target.label} · ${target.samples} samples\n${target.metrics.join('\n')}\n${target.findings.join('\n')}`), `Evidence gaps: ${report.evidenceGaps}`].join('\n');
}

registerWorkbenchContribution('workbench.contrib.memoryDiagnostics', WorkbenchPhase.BlockStartup, accessor => {
	const registrations = new DisposableStore();
	if (!accessor.getOptional(IMemoryDiagnosticsService)) { return registrations; }
	for (const [operation, title] of [['start', 'Start Memory Diagnostics'], ['read', 'Show Memory Diagnostics'], ['stop', 'Stop Memory Diagnostics'], ['export', 'Export Memory Diagnostic Report']] as const) {
		registrations.add(registerAction2(class MemoryAction extends Action2 {
			constructor() { super({ id: `ash.memory.${operation}`, title, f1: true }); }
			public override async run(services: ServicesAccessor): Promise<void> {
				const memory = services.get(IMemoryDiagnosticsService);
				const notifications = services.get(INotificationService);
				try {
					if (operation === 'export') {
						const bytes = await memory.export();
						triggerDownload(new Blob([new Uint8Array(bytes)], { type: 'application/json' }), `memory-diagnostics-${Date.now()}.json`, document);
					} else { notifications.info(describe(await memory[operation]())); }
				} catch (error) { notifications.error(error instanceof Error ? error.message : String(error)); }
			}
		}));
	}
	return registrations;
});
