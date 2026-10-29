import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { parseLogLevel } from '../../../../platform/log/common/log.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ConsoleLogSink } from '../../../../platform/log/common/consoleLogSink.js';
import type { ILogFileService } from '../../../../platform/log/common/log.js';
import { LoggerChannelClient } from '../../../../platform/log/common/logIpc.js';
import { LogService } from '../../../../platform/log/common/logServiceImpl.js';

/** One window owns recording and replay; Main alone owns the saved files. */
export class NativeLogService extends LogService {
	readonly files: ILogFileService;

	constructor(category: string, @IMainProcessService mainProcessService: IMainProcessService, @IWorkbenchEnvironmentService environment: IWorkbenchEnvironmentService) {
		const client = new LoggerChannelClient(mainProcessService.getChannel('logger'));
		super({
			level: environment.initialLogLevel ?? (environment.logLevel ? parseLogLevel(environment.logLevel) : undefined),
			sinks: [
				new ConsoleLogSink(),
				{
					log: entry =>
						client.log({
							...entry,
							category: entry.category === 'application' ? category : entry.category,
						}),
				},
			],
			flush: () => client.flush(),
		});
		this._register(client);
		this.files = client.files;
	}
}
