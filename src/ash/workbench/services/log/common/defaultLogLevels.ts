import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { isRecord } from '../../../../base/common/types.js';
import { extUri } from '../../../../base/common/resources.js';
import {
	DEFAULT_LOG_LEVEL,
	ILoggerService,
	ILogService,
	LogLevelToString,
	parseLogLevel,
	type ILogger,
	type LogLevel,
} from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import {
	IFileService,
	FileSystemProviderErrorCode,
	toFileSystemProviderErrorCode,
} from '../../../../platform/files/common/files.js';
import { IWorkbenchEnvironmentService } from '../../environment/common/environmentService.js';
import { IJSONEditingService } from '../../configuration/common/jsonEditing.js';
import { IOutputService } from '../../output/common/output.js';
import { ILifecycleService } from '../../lifecycle/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { localize } from '../../../../nls.js';

export type DefaultLogLevels = Readonly<{ default: LogLevel; extensions: [string, LogLevel][] }>;
export const IDefaultLogLevelsService = createDecorator<IDefaultLogLevelsService>('IDefaultLogLevelsService');
export interface IDefaultLogLevelsService {
	readonly defaultLogLevels: DefaultLogLevels;
	readonly onDidChangeDefaultLogLevels: Event<DefaultLogLevels>;
	getDefaultLogLevel(extensionId?: string): LogLevel;
	setDefaultLogLevel(logLevel: LogLevel, extensionId?: string): Promise<void>;
}

/** One decoder owns startup and live-resource log-level syntax for every host. */
export function parseDefaultLogLevels(
	value: unknown,
	fallback: DefaultLogLevels = { default: DEFAULT_LOG_LEVEL, extensions: [] },
): DefaultLogLevels {
	const entries = value === undefined ? [] : typeof value === 'string' ? [value] : value;
	if (!Array.isArray(entries) || entries.length > 512 || entries.some(entry => typeof entry !== 'string')) {
		throw new TypeError(
			localize('logs.invalidLevels', 'log-level must be a string or an array of log level strings.'),
		);
	}
	let level = fallback.default;
	const extensions = new Map(fallback.extensions);
	for (const entry of entries as string[]) {
		const separator = entry.indexOf('=');
		const id = separator < 0 ? undefined : entry.slice(0, separator).toLowerCase();
		const parsed = parseLogLevel(separator < 0 ? entry : entry.slice(separator + 1));
		if (parsed === undefined || (id !== undefined && !/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(id))) {
			throw new TypeError(localize('logs.invalidLevel', 'Invalid log level entry: {0}', entry));
		}
		if (id === undefined) level = parsed;
		else extensions.set(id, parsed);
	}
	return Object.freeze({ default: level, extensions: [...extensions] });
}

export class DefaultLogLevelsService extends Disposable implements IDefaultLogLevelsService {
	private state: DefaultLogLevels;
	private readonly initialized = new WeakSet<ILogger>();
	private readonly changed = this._register(new Emitter<DefaultLogLevels>());
	readonly onDidChangeDefaultLogLevels = this.changed.event;
	private pending: Promise<void> = Promise.resolve();

	constructor(
		initial: DefaultLogLevels | undefined,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@IFileService private readonly files: IFileService,
		@IJSONEditingService private readonly editing: IJSONEditingService,
		@ILogService private readonly log: ILogService,
		@ILoggerService private readonly loggers: ILoggerService,
		@IOutputService private readonly output: IOutputService,
		@ILifecycleService lifecycle: ILifecycleService,
	) {
		super();
		this.state = initial ?? this.startupLevels();
		this._register(files.watch(environment.argvResource));
		this._register(
			files.onDidChangeFiles(event => {
				if (
					!event.resources ||
					event.resources.some(resource => extUri.isEqual(resource, environment.argvResource))
				) {
					void this.enqueue(async () => {
						this.accept(parseDefaultLogLevels(await this.readEntries(), this.startupLevels()));
					}).catch(error => {
						if (!this.isDisposed)
							this.log.error(
								'logs',
								localize('logs.reloadFailed', 'Could not reload default log levels.'),
								error,
							);
					});
				}
			}),
		);
		this._register(
			loggers.onDidChangeLoggers(event => {
				for (const info of event.added) {
					if (info.logLevel === undefined)
						loggers.getLogger(info.id)?.setLevel(this.getDefaultLogLevel(info.extensionId));
				}
			}),
		);
		this._register(output.onDidChangeChannels(() => this.initializeChannels()));
		this.initializeChannels();
		// Producers release channels during scope teardown, after DI lookups are retired.
		this._register(lifecycle.onDidShutdown(() => this.dispose()));
	}
	get defaultLogLevels(): DefaultLogLevels {
		return this.state;
	}
	getDefaultLogLevel(extensionId?: string): LogLevel {
		return this.levelFor(this.state, extensionId);
	}

	setDefaultLogLevel(logLevel: LogLevel, extensionId?: string): Promise<void> {
		return this.enqueue(async () => {
			const previous = await this.readEntries();
			parseDefaultLogLevels(previous);
			const entries =
				previous === undefined ? [] : typeof previous === 'string' ? [previous] : (previous as string[]);
			const id = extensionId?.toLowerCase();
			const next = entries.filter(entry => {
				const separator = entry.indexOf('=');
				return id === undefined
					? separator >= 0
					: separator < 0 || entry.slice(0, separator).toLowerCase() !== id;
			});
			next.push(`${id ? id + '=' : ''}${LogLevelToString(logLevel)}`);
			const state = parseDefaultLogLevels(next, this.startupLevels());
			await this.editing.write(this.environment.argvResource, [{ path: ['log-level'], value: next }], true);
			if (!this.isDisposed) this.accept(state);
		});
	}

	private startupLevels(): DefaultLogLevels {
		return parseDefaultLogLevels([
			this.environment.logLevel ?? 'info',
			...(this.environment.extensionLogLevel ?? []).map(([id, level]) => `${id}=${level}`),
		]);
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		const result = this.pending.then(async () => {
			if (!this.isDisposed) await work();
		});
		this.pending = result.catch(() => undefined);
		return result;
	}

	private async readEntries(): Promise<unknown> {
		try {
			const file = await this.files.readFile(this.environment.argvResource);
			const document = parseJsonc(file.content, this.environment.argvResource.toString());
			if (!isRecord(document)) {
				throw new TypeError(localize('logs.invalidArgv', 'The startup configuration must be a JSON object.'));
			}
			return document['log-level'];
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound)
				return undefined;
			throw error;
		}
	}

	private levelFor(state: DefaultLogLevels, extensionId?: string): LogLevel {
		return state.extensions.find(([id]) => id === extensionId?.toLowerCase())?.[1] ?? state.default;
	}

	private initializeChannels(): void {
		for (const channel of this.output.channels) {
			const logger = channel.descriptor.logger?.control;
			if (logger && !this.initialized.has(logger)) {
				this.initialized.add(logger);
				const info = [...this.loggers.getRegisteredLoggers()].find(
					info => this.loggers.getLogger(info.id) === logger,
				);
				if (info?.logLevel === undefined)
					logger.setLevel(this.getDefaultLogLevel(channel.descriptor.extensionId));
			}
		}
	}

	private accept(next: DefaultLogLevels): void {
		if (this.isDisposed || JSON.stringify(next) === JSON.stringify(this.state)) return;
		const previous = this.state;
		this.state = next;
		const visited = new Set<ILogger>();
		const update = (logger: ILogger | undefined, extensionId?: string, explicit = false): void => {
			if (!logger || visited.has(logger)) return;
			visited.add(logger);
			if (explicit) return;
			if (logger.getLevel() === this.levelFor(previous, extensionId))
				logger.setLevel(this.levelFor(next, extensionId));
		};
		for (const info of this.loggers.getRegisteredLoggers()) {
			update(this.loggers.getLogger(info.id), info.extensionId, info.logLevel !== undefined);
		}
		for (const channel of this.output.channels)
			update(channel.descriptor.logger?.control, channel.descriptor.extensionId);
		this.changed.fire(next);
	}
}
registerSingleton(IDefaultLogLevelsService, new SyncDescriptor(DefaultLogLevelsService, [undefined], true));

/** Startup awaits this snapshot before constructing consumers or emitting Window diagnostics. */
export async function readDefaultLogLevels(
	files: IFileService,
	environment: IWorkbenchEnvironmentService,
	log: ILogService,
): Promise<DefaultLogLevels> {
	let state: DefaultLogLevels = { default: DEFAULT_LOG_LEVEL, extensions: [] };
	try {
		const file = await files.readFile(environment.argvResource);
		const document = parseJsonc(file.content, environment.argvResource.toString());
		if (!isRecord(document))
			throw new TypeError(localize('logs.invalidArgv', 'The startup configuration must be a JSON object.'));
		state = parseDefaultLogLevels(document['log-level']);
	} catch (error) {
		if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) {
			log.error('logs', localize('logs.readFailed', 'Could not read startup log levels.'), error);
		}
	}
	return parseDefaultLogLevels(
		[
			...(environment.logLevel ? [environment.logLevel] : []),
			...(environment.extensionLogLevel ?? []).map(([id, level]) => `${id}=${level}`),
		],
		state,
	);
}
