import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { JsonSchema } from '../../../base/common/jsonSchema.js';
import type { URI } from '../../../base/common/uri.js';

export interface JsonSchemaChangeEvent {
	readonly schemaId: string;
	readonly resource: URI | undefined;
}

/** Owns JSON schemas and exact resource associations independently of language features. */
export class JsonSchemaRegistry extends Disposable {
	private readonly schemas = new Map<string, JsonSchema>();
	private readonly associations = new Map<string, string>();
	private readonly changeEmitter = this._register(new Emitter<JsonSchemaChangeEvent>());

	public readonly onDidChange: Event<JsonSchemaChangeEvent> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.associations.clear();
			this.schemas.clear();
		}));
	}

	public registerSchema(schemaId: string, schema: JsonSchema): IDisposable {
		this.assertNotDisposed();
		assertSchemaId(schemaId);
		if (!schema || typeof schema !== 'object') throw new TypeError('JSON schema must be an object');
		if (this.schemas.has(schemaId)) throw new Error(`JSON schema is already registered: ${schemaId}`);
		this.schemas.set(schemaId, schema);
		this.changeEmitter.fire(Object.freeze({ schemaId, resource: undefined }));
		return toDisposable(() => {
			if (this.schemas.get(schemaId) !== schema) return;
			this.schemas.delete(schemaId);
			this.changeEmitter.fire(Object.freeze({ schemaId, resource: undefined }));
		});
	}

	public registerAssociation(resource: URI, schemaId: string): IDisposable {
		this.assertNotDisposed();
		assertSchemaId(schemaId);
		const resourceId = resource.toString();
		if (this.associations.has(resourceId)) throw new Error(`A JSON schema is already associated with ${resourceId}`);
		this.associations.set(resourceId, schemaId);
		this.changeEmitter.fire(Object.freeze({ schemaId, resource }));
		return toDisposable(() => {
			if (this.associations.get(resourceId) !== schemaId) return;
			this.associations.delete(resourceId);
			this.changeEmitter.fire(Object.freeze({ schemaId, resource }));
		});
	}

	public getSchema(schemaId: string): JsonSchema | undefined {
		assertSchemaId(schemaId);
		return this.schemas.get(schemaId);
	}

	public getSchemaForResource(resource: URI | undefined): JsonSchema | undefined {
		if (!resource) return undefined;
		const schemaId = this.getSchemaIdForResource(resource);
		return schemaId ? this.schemas.get(schemaId) : undefined;
	}

	public getSchemaIdForResource(resource: URI | undefined): string | undefined {
		return resource ? this.associations.get(resource.toString()) : undefined;
	}
}

export const JsonSchemasRegistry = new JsonSchemaRegistry();

function assertSchemaId(schemaId: string): void {
	if (typeof schemaId !== 'string' || schemaId.length === 0) throw new TypeError('JSON schema ID must not be empty');
}
