import type { ITelemetryService } from '../../telemetry/common/telemetry.js';

export type IntegratedBrowserOpenSource =
	| 'canvas'
	| 'cdpCreated'
	| 'chatTool'
	| 'commandWithoutUrl'
	| 'commandWithUrl'
	| 'quickOpenWithoutUrl'
	| 'quickOpenWithUrl'
	| 'newTabCommand'
	| 'localhostLinkOpener'
	| 'browserLinkForeground'
	| 'browserLinkBackground'
	| 'browserLinkNewWindow'
	| 'copyToNewWindow'
	| 'openFileCommand'
	| 'fileResource';

/** The shared telemetry service controls collection; website identity is never included. */
export function logBrowserOpen(telemetryService: ITelemetryService, source: IntegratedBrowserOpenSource): void {
	telemetryService.publicLog2<
		{ source: IntegratedBrowserOpenSource },
		{
			owner: 'ash';
			comment: 'How the integrated browser was opened.';
			source: {
				classification: 'SystemMetaData';
				purpose: 'FeatureInsight';
				comment: 'Browser open entry point.';
			};
		}
	>('integratedBrowser.open', { source });
}
