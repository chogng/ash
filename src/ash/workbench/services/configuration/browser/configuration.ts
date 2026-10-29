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
import { getConfigurationMigrations } from '../../../common/configuration.js';

/** Rewrite a settings document once, retaining JSONC and leaving failed migrations intact. */
export async function migrateSettings(source: string, onError: (error: unknown) => void): Promise<string> {
	const migrations = getConfigurationMigrations();
	if (!migrations.length) return source;
	const document = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
	// Invalid documents stay with the file owner's parser and its existing diagnostics.
	if (document.errors.length || document.root?.type !== 'object') return source;
	const parse = (text: string) => {
		const result = parseJsonDocument(text, { allowComments: true, allowTrailingComma: true });
		if (result.errors.length || result.root?.type !== 'object') throw new TypeError('Settings JSONC is invalid');
		return result.value as Record<string, unknown>;
	};
	let output = source;
	const original = parse(source);
	// Language overrides are independent settings maps and migrate independently.
	for (const block of [undefined, ...Object.keys(original).filter(key => /^\[.+\]$/u.test(key))]) {
		const parsed = parseJsonDocument(output, { allowComments: true, allowTrailingComma: true });
		const node = block === undefined || parsed.root?.type !== 'object' ? undefined : parsed.root.properties.find(property => property.key === block)?.valueNode;
		let text = node ? output.slice(node.offset, node.offset + node.length) : output;
		if (!text || (block !== undefined && (typeof original[block] !== 'object' || !original[block] || Array.isArray(original[block])))) continue;
		for (const migration of migrations) {
			const values = parse(text);
			if (!Object.hasOwn(values, migration.key)) continue;
			try {
				const result = await migration.migrateFn(values[migration.key], key => values[key]);
				const updates = Array.isArray(result) ? result : [[migration.key, result] as const];
				let next = text;
				for (const [key, value] of updates) next = editJsonObjectProperty(next, key, value.value);
				text = next;
			} catch (error) {
				onError(error);
			}
		}
		if (block === undefined) output = text;
		else if (node && !equals(parse(text), original[block])) output = output.slice(0, node.offset) + text + output.slice(node.offset + node.length);
	}
	return output;
}

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
		private readonly onError: (error: unknown) => void,
	) {
		super();
		this._register(files.watch(dirname(resource), { recursive: false, excludes: [] }));
		this._register(
			files.onDidChangeFiles(event => {
				if (!event.resources || event.resources.some(candidate => extUriBiasedIgnorePathCase.isEqualOrParent(resource, candidate))) {
					void this.loadConfiguration().catch(error => {
						if (!this.stopped) onError(error);
					});
				}
			}),
		);
	}

	getConfiguration(): ConfigurationModel {
		return this.document;
	}

	loadConfiguration(): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) return;
			const { source, revision } = await this.read();
			if (this.stopped) return;
			const settings = this.extract(source);
			const migrated = await migrateSettings(settings.source, this.onError);
			const document = this.parseSource(migrated);
			if (migrated !== settings.source) {
				const output = this.replaceSettings(source, migrated);
				await this.files.writeFile({ resource: this.resource, content: output, expectedRevision: revision }, { create: true, overwrite: revision !== undefined }, this.cancellation.signal);
			}
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
			const output = this.replaceSettings(source, next.source);
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

	private replaceSettings(source: string, settings: string): string {
		if (!this.nested) return settings;
		const parsed = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
		const node = parsed.root?.type === 'object' ? parsed.root.properties.find(property => property.key === 'settings')?.valueNode : undefined;
		return node
			? source.slice(0, node.offset) + settings + source.slice(node.offset + node.length)
			: editJsonObjectProperty(source, 'settings', parseJsonDocument(settings, { allowComments: true, allowTrailingComma: true }).value);
	}

	private async read(): Promise<{ source: string; revision?: string }> {
		try {
			const file = await this.files.readFile(this.resource);
			return { source: file.content, revision: file.revision };
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotFound) return { source: '{}' };
			throw error;
		}
	}

	private parseSource(source: string): { source: string; model: ConfigurationModel } {
		const parser = new ConfigurationModelParser(this.resource.toString(), settingsLog);
		parser.parse(source);
		if (parser.errors.length) throw new TypeError(localize('configuration.invalidWorkspace', 'Workspace settings in {0} contain invalid JSONC.', this.resource.toString()));
		return { source, model: parser.configurationModel };
	}

	private extract(source: string): { source: string; model: ConfigurationModel } {
		if (!this.nested) return this.parseSource(source);
		const parsed = parseJsonDocument(source, { allowComments: true, allowTrailingComma: true });
		if (parsed.errors.length || parsed.root?.type !== 'object')
			throw new TypeError(localize('configuration.invalidWorkspace', 'Workspace settings in {0} contain invalid JSONC.', this.resource.toString()));
		const settings = parsed.root.properties.find(property => property.key === 'settings')?.valueNode;
		return this.parseSource(settings ? source.slice(settings.offset, settings.offset + settings.length) : '{}');
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
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
