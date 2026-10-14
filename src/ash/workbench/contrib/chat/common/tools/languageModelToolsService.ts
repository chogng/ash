import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { IObservable, IReader } from '../../../../../base/common/observable.js';
import type { Event } from '../../../../../base/common/event.js';

export type ToolAuthority = 'directoryRead' | 'directoryWrite' | 'processExecution' | 'productService' | 'providerDefined';
export type ToolSource = 'environment' | 'dynamic' | 'extension' | 'host' | 'local' | 'mcp';
export type ToolExposure = 'direct' | 'deferred' | 'modelOnly' | 'hidden';

export interface IToolData {
	readonly id: string;
	readonly toolReferenceName: string;
	readonly displayName: string;
	readonly modelDescription: string;
	readonly canBeReferencedInPrompt: boolean;
	/** Ash backend provenance and policy metadata; not a frontend ToolDataSource registry. */
	readonly source: ToolSource;
	readonly sourceDetails: readonly string[];
	readonly exposure: ToolExposure;
	readonly authority: ToolAuthority;
}

export interface IToolSet {
	readonly id: string;
	readonly referenceName: string;
	readonly source: ToolSource;
	readonly sourceId: string;
	getTools(reader?: IReader): Iterable<IToolData>;
}

/**
 * Reads the backend-owned tool catalog for pickers, settings and prompt completions.
 * Unlike VS Code's frontend registry, registration, model filtering and execution
 * belong to the App Server. Refresh atomically replaces a read-only window view;
 * synchronous queries never register, enable or execute tools locally.
 * The current protocol has no model-scoped query.
 */
export interface ILanguageModelToolsService {
	readonly isAvailable: boolean;
	/** Fires after the readable catalog is replaced, including connection invalidation. */
	readonly onDidChangeTools: Event<void>;
	/** Load before querying. Concurrent consumers share the same in-flight read. */
	refresh(): Promise<void>;
	getAllToolsIncludingDisabled(): Iterable<IToolData>;
	readonly toolSets: IObservable<Iterable<IToolSet>>;
	getFullReferenceNames(): Iterable<string>;
	getFullReferenceName(tool: IToolData | IToolSet, toolSet?: IToolSet): string;
	getToolByFullReferenceName(fullReferenceName: string): IToolData | IToolSet | undefined;
}

export const ILanguageModelToolsService = createServiceIdentifier<ILanguageModelToolsService>('ILanguageModelToolsService');

export function isToolSet(tool: IToolData | IToolSet | undefined): tool is IToolSet {
	return tool !== undefined && 'getTools' in tool;
}
