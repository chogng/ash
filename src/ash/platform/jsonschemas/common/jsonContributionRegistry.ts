import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { JsonSchema } from '../../../base/common/jsonSchema.js';
import { Registry } from '../../registry/common/platform.js';

export const Extensions = { JSONContribution: 'base.contributions.json' };

export interface ISchemaContributions {
	readonly schemas: { [id: string]: JsonSchema };
}

export interface IJSONContributionRegistry {
	readonly onDidChangeSchema: Event<string>;
	readonly onDidChangeSchemaAssociations: Event<void>;
	registerSchema(uri: string, unresolvedSchemaContent: JsonSchema, store?: DisposableStore): void;
	registerSchemaAssociation(uri: string, glob: string): IDisposable;
	notifySchemaChanged(uri: string): void;
	getSchemaContributions(): ISchemaContributions;
	getSchemaAssociations(): { [uri: string]: string[] };
}

/** Stores contributions; JSON language features own resource matching and schema evaluation. */
class JSONContributionRegistry extends Disposable implements IJSONContributionRegistry {
	private readonly schemas = new Map<string, { schema: JsonSchema }>();
	private readonly associations = new Map<string, Map<string, number>>();
	private readonly schemaChanged = this._register(new Emitter<string>());
	private readonly associationsChanged = this._register(new Emitter<void>());
	public readonly onDidChangeSchema = this.schemaChanged.event;
	public readonly onDidChangeSchemaAssociations = this.associationsChanged.event;

	public registerSchema(uri: string, unresolvedSchemaContent: JsonSchema, store?: DisposableStore): void {
		this.assertNotDisposed();
		const id = normalizeSchemaId(uri);
		const registration = { schema: unresolvedSchemaContent };
		this.schemas.set(id, registration);
		store?.add(toDisposable(() => {
			// A retired contribution must not unregister a later replacement of the same schema ID.
			if (this.schemas.get(id) === registration) {
				this.schemas.delete(id);
				this.schemaChanged.fire(id);
			}
		}));
		this.schemaChanged.fire(id);
	}

	public registerSchemaAssociation(uri: string, glob: string): IDisposable {
		this.assertNotDisposed();
		const id = normalizeSchemaId(uri);
		let patterns = this.associations.get(id);
		if (!patterns) {
			patterns = new Map();
			this.associations.set(id, patterns);
		}
		const references = patterns.get(glob) ?? 0;
		patterns.set(glob, references + 1);
		if (references === 0) { this.associationsChanged.fire(); }
		return toDisposable(() => {
			const remaining = patterns.get(glob)! - 1;
			if (remaining > 0) { patterns.set(glob, remaining); }
			else {
				patterns.delete(glob);
				if (patterns.size === 0) { this.associations.delete(id); }
				this.associationsChanged.fire();
			}
		});
	}

	public notifySchemaChanged(uri: string): void {
		this.schemaChanged.fire(normalizeSchemaId(uri));
	}

	public getSchemaContributions(): ISchemaContributions {
		return { schemas: Object.fromEntries([...this.schemas].map(([id, entry]) => [id, entry.schema])) };
	}

	public getSchemaAssociations(): { [uri: string]: string[] } {
		return Object.fromEntries([...this.associations].map(([id, patterns]) => [id, [...patterns.keys()]]));
	}
}

Registry.add(Extensions.JSONContribution, new JSONContributionRegistry());

function normalizeSchemaId(uri: string): string {
	return uri.endsWith('#') ? uri.slice(0, -1) : uri;
}
