import type { ILanguageApi } from '../../../../platform/language/common/languageApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	addToValueTree,
	isConfigured,
	type IConfigurationService,
} from '../../../../platform/configuration/common/configuration.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import type { JsonValue as ProtocolJsonValue } from '../../../../../../.build/protocol/typescript/index.js';
import { equals } from '../../../../base/common/arrays.js';

interface LanguageServer {
	readonly id: string;
	readonly languageIds: readonly string[];
}

export class AppServerLanguageSupport {
	constructor(private readonly directories: ReadonlyMap<string, readonly LanguageServer[]> = new Map()) {}

	static async read(
		api: ILanguageApi,
		workspace: IWorkspaceContextService,
		configuration: IConfigurationService,
	): Promise<AppServerLanguageSupport> {
		const folders = workspace.getWorkspace().folders;
		const entries = await Promise.all(
			folders.map(async folder => {
				const overrides = { resource: folder.uri };
				const rust: Record<string, JsonValue> = {};
				// The catalog documents upstream defaults; sending them all would override
				// explicit App Server launch options. Only Ash's memory default is implicit.
				const keys = configuration.keys();
				const registered = new Set(keys.default);
				for (const key of new Set([
					'rust-analyzer.cachePriming.enable',
					...keys.user,
					...keys.workspace,
					...keys.workspaceFolder,
					...(keys.memory ?? []),
					...keys.policy,
				])) {
					if (!key.startsWith('rust-analyzer.')) continue;
					if (key !== 'rust-analyzer.cachePriming.enable' && registered.has(key)) {
						// keys() includes every folder; inspect only the current directory's layer.
						const inspected = configuration.inspect<JsonValue>(key, overrides);
						if (
							!isConfigured(inspected) &&
							inspected.memoryValue === undefined &&
							inspected.policyValue === undefined
						)
							continue;
					}
					const value = configuration.getValue<JsonValue | undefined>(key, overrides);
					if (value !== undefined)
						addToValueTree(rust, key.slice('rust-analyzer.'.length), structuredClone(value), message => {
							throw new Error(message);
						});
				}
				// An empty section on removal retires the previous runtime override.
				const settings = { 'rust-analyzer': protocolJsonValue(rust) };
				const result = await api.servers({ ...(folders.length > 1 ? { dirId: folder.id } : {}), settings });
				return [
					folder.id,
					result.servers.map(server => ({ id: server.id, languageIds: server.languageIds })),
				] as const;
			}),
		);
		return new AppServerLanguageSupport(new Map(entries));
	}

	get languageIds(): readonly string[] {
		return [
			...new Set(
				[...this.directories.values()].flatMap(servers => servers.flatMap(server => server.languageIds)),
			),
		];
	}

	equals(other: AppServerLanguageSupport): boolean {
		return (
			this.directories.size === other.directories.size &&
			[...this.directories].every(([dirId, servers]) => {
				const candidates = other.directories.get(dirId);
				return (
					candidates !== undefined &&
					equals(
						servers,
						candidates,
						(left, right) => left.id === right.id && equals(left.languageIds, right.languageIds),
					)
				);
			})
		);
	}

	supports(dirId: string, languageId: string): boolean {
		return this.directories.get(dirId)?.some(server => server.languageIds.includes(languageId)) ?? false;
	}

	workspaceLanguageIds(dirId: string): readonly string[] {
		return (this.directories.get(dirId) ?? []).flatMap(server => server.languageIds.slice(0, 1));
	}
}

function protocolJsonValue(value: JsonValue): ProtocolJsonValue {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(protocolJsonValue);
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, protocolJsonValue(entry)]));
}
