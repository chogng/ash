import { type Event } from "../../../base/common/event.js";
import {
	Disposable,
} from "../../../base/common/lifecycle.js";
import type { IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import {
	RevisionedJsonFile,
} from "../../storage/node/revisionedJsonFile.js";
import {
	emptyConfigurationDocument,
	type IConfigurationDocument,
	type IConfigurationSnapshot,
	type IConfigurationUpdateRequest,
	validateConfigurationDocument,
	validateConfigurationRead,
	validateConfigurationUpdateRequest,
} from "../common/configurationIpc.js";

export interface ConfigurationMainServiceOptions {
	readonly filePath: string;
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns the Desktop configuration resource in the Electron main process.
 */
export class ConfigurationMainService extends Disposable {
	private readonly resource: RevisionedJsonFile<IConfigurationDocument>;

	private constructor(
		resource: RevisionedJsonFile<IConfigurationDocument>,
	) {
		super();
		this.resource = this._register(resource);
	}

	static async create(
		options: ConfigurationMainServiceOptions,
	): Promise<ConfigurationMainService> {
		const resource = await RevisionedJsonFile.create({
			filePath: options.filePath,
			defaultValue: emptyConfigurationDocument,
			validate: validateConfigurationDocument,
			parse: source => ({ version: 1, source }),
			serialize: document => document.source,
			label: "Configuration",
			onError: options.onError,
		});
		return new ConfigurationMainService(resource);
	}

	get onDidChange(): Event<IConfigurationSnapshot> {
		return (listener) => this.resource.onDidChange((snapshot) =>
			listener({
				revision: snapshot.revision,
				document: snapshot.value,
			})
		);
	}

	read(): IConfigurationSnapshot {
		const snapshot = this.resource.read();
		return {
			revision: snapshot.revision,
			document: snapshot.value,
		};
	}

	async update(
		request: IConfigurationUpdateRequest,
	): Promise<IConfigurationSnapshot> {
		const snapshot = await this.resource.update(
			request.expectedRevision,
			request.document,
		);
		return {
			revision: snapshot.revision,
			document: snapshot.value,
		};
	}

	async close(): Promise<void> {
		await this.resource.close();
		this.dispose();
	}
}

export function configurationChannel(service: ConfigurationMainService): IServerChannel {
	return {
		async call<T>(_context: string, command: string, arg?: unknown): Promise<T> {
			switch (command) {
				case 'read': validateConfigurationRead(arg); return service.read() as T;
				case 'update': return await service.update(validateConfigurationUpdateRequest(arg)) as T;
				default: throw new Error(`Unknown configuration command: ${command}`);
			}
		},
		listen<T>(_context: string, event: string, arg?: unknown): Event<T> {
			if (event !== 'onDidChange' || arg !== undefined) { throw new TypeError('Invalid configuration subscription'); }
			return service.onDidChange as Event<T>;
		},
	};
}
