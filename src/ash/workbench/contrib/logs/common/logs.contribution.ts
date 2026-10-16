import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILoggerService, type ILoggerResource } from '../../../../platform/log/common/log.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IOutputService } from '../../../services/output/common/output.js';

/** Output borrows registered loggers; their producers retain level and lifetime ownership. */
class LogsContribution extends Disposable {
	private readonly channels = this._register(new DisposableMap<string, DisposableStore>());

	constructor(@ILoggerService loggers: ILoggerService, @IOutputService output: IOutputService) {
		super();
		const add = (info: ILoggerResource): void => {
			if (info.hidden || this.channels.has(info.id)) return;
			const logger = loggers.getLogger(info.id);
			if (!logger) return;
			const lifetime = new DisposableStore();
			const label = info.name ?? info.id;
			const channel = lifetime.add(output.createChannel({
				id: `logger.${encodeURIComponent(info.id)}`, label, kind: 'log', source: 'core',
				logger: { label, control: logger },
			}));
			lifetime.add(logger.registerSink({
				log: entry => {
					const error = entry.error instanceof Error ? entry.error.stack ?? entry.error.message : entry.error;
					channel.appendLine({
						timestamp: entry.timestampMillis, severity: entry.level, category: entry.category,
						text: error === undefined ? entry.message : `${entry.message}\n${String(error)}`,
					});
				}
			}, true));
			this.channels.set(info.id, lifetime);
		};
		this._register(loggers.onDidChangeLoggers(event => {
			for (const info of event.removed) this.channels.deleteAndDispose(info.id);
			for (const info of event.added) add(info);
		}));
		this._register(loggers.onDidChangeVisibility(([id, visible]) => {
			if (!visible) this.channels.deleteAndDispose(id);
			else for (const info of loggers.getRegisteredLoggers()) if (info.id === id) add(info);
		}));
		for (const info of loggers.getRegisteredLoggers()) add(info);
	}
}

registerWorkbenchContribution('workbench.contrib.logs', WorkbenchPhase.AfterRestored, services => services.get(IInstantiationService).createInstance(LogsContribution));
