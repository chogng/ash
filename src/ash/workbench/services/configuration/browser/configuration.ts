import { Emitter } from '../../../../base/common/event.js';
import { editJsonObjectProperty, parseJsonDocument } from '../../../../base/common/json.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import { ConfigurationModel, ConfigurationModelParser } from '../../../../platform/configuration/common/configurationModels.js';
import { NullLoggerService } from '../../../../platform/log/common/log.js';
import { equals } from '../../../../base/common/objects.js';
const settingsLog = new NullLoggerService();
import { localize } from '../../../../nls.js';

/** Owns one settings file's last valid source, conditional writes and watch lifetime. */
class SettingsFile extends Disposable {
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidUpdateConfiguration = this.changes.event;
	private document = ConfigurationModel.createEmptyModel(settingsLog);
	private stopped = false;
	private readonly cancellation = new AbortController();
	private queue: Promise<void> = Promise.resolve();

	constructor(
		readonly resource: URI,
		private readonly files: IFileService,
		private readonly nested: boolean,
		onError: (error: unknown) => void,
	) {
		super();
		this._register(files.watch(dirname(resource), { recursive: false, excludes: [] }));
		this._register(files.onDidChangeFiles(event => {
			if (!event.resources || event.resources.some(candidate => extUriBiasedIgnorePathCase.isEqualOrParent(resource, candidate))) {
				void this.loadConfiguration().catch(error => { if (!this.stopped) onError(error); });
			}
		}));
	}

	getConfiguration(): ConfigurationModel {
		return this.document;
	}

	loadConfiguration(): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) return;
			const { source } = await this.read();
			if (this.stopped) return;
			const document = this.extract(source);
			if (!this.stopped && !equals(document.model.toJSON(), this.document.toJSON())) {
				this.document = document.model;
				this.changes.fire();
			}
		});
	}

	write(transform: (source: string) => string): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) throw new Error('Configuration resource was disposed');
			const { source, revision } = await this.read();
			const settings = this.extract(source);
			const next = this.parseSource(transform(settings.source));
			if (this.stopped) throw new Error('Configuration resource was disposed');
			let output = next.source;
			if (this.nested) {
				const parsed = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
				const settingsNode = parsed.root?.type === 'object' ? parsed.root.properties.find(property => property.key === 'settings')?.valueNode : undefined;
				// Replace only the settings value, retaining comments both inside and outside it.
				output = settingsNode ? source.slice(0, settingsNode.offset) + next.source + source.slice(settingsNode.offset + settingsNode.length)
					: editJsonObjectProperty(source, 'settings', parseJsonDocument(next.source, { allowComments: true, allowTrailingComma: true }).value);
			}
			if (output !== source) {
				await this.files.createDirectory(dirname(this.resource));
				await this.files.writeFile({ resource: this.resource, content: output, expectedRevision: revision }, { create: true, overwrite: revision !== undefined }, this.cancellation.signal);
			}
			if (!this.stopped) {
				this.document = next.model;
				this.changes.fire();
			}
		});
	}

	private async read(): Promise<{ source: string; revision?: string; }> {
		try {
			const file = await this.files.readFile(this.resource);
			return { source: file.content, revision: file.revision };
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound) return { source: '{}' };
			throw error;
		}
	}

	private parseSource(source: string): { source: string; model: ConfigurationModel; } {
		const parser = new ConfigurationModelParser(this.resource.toString(), settingsLog);
		parser.parse(source);
		if (parser.errors.length) throw new TypeError(localize('configuration.invalidWorkspace', 'Workspace settings in {0} contain invalid JSONC.', this.resource.toString()));
		return { source, model: parser.configurationModel };
	}

	private extract(source: string): { source: string; model: ConfigurationModel; } {
		if (!this.nested) return this.parseSource(source);
		const parsed = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
		if (parsed.errors.length || parsed.root?.type !== 'object') throw new TypeError(localize('configuration.invalidWorkspace', 'Workspace settings in {0} contain invalid JSONC.', this.resource.toString()));
		const settings = parsed.root.properties.find(property => property.key === 'settings')?.valueNode;
		return this.parseSource(settings ? source.slice(settings.offset, settings.offset + settings.length) : '{}');
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => { });
		return result;
	}

	override dispose(): void {
		this.stopped = true;
		this.cancellation.abort();
		super.dispose();
	}
}

export class WorkspaceConfiguration extends SettingsFile {
	constructor(resource: URI, files: IFileService, onError: (error: unknown) => void) {
		super(resource, files, true, onError);
	}
}

export class FolderConfiguration extends SettingsFile {
	constructor(resource: URI, files: IFileService, onError: (error: unknown) => void) {
		super(resource, files, false, onError);
	}
}
