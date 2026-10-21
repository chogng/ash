import type { ILanguageApi } from '../../../../platform/language/common/languageApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { JsonValue } from '../../../../base/common/jsonValue.js';
import type { JsonValue as ProtocolJsonValue } from '../../../../../../.build/protocol/typescript/index.js';

interface LanguageServer {
	readonly id: string;
	readonly languageIds: readonly string[];
}

export class AppServerLanguageSupport {
	constructor(private readonly directories: ReadonlyMap<string, readonly LanguageServer[]> = new Map()) { }

	static async read(api: ILanguageApi, workspace: IWorkspaceContextService, configuration: IConfigurationService): Promise<AppServerLanguageSupport> {
		const folders = workspace.getWorkspace().folders;
		const entries = await Promise.all(folders.map(async folder => {
			// The configuration owner has already merged profile, workspace and folder JSONC.
			// Send an empty section on removal so the previous runtime override is retired.
			const settings = { 'rust-analyzer': protocolJsonValue(configuration.getValue<JsonValue>('rust-analyzer', { resource: folder.uri }) ?? {}) };
			const result = await api.servers({ ...(folders.length > 1 ? { dirId: folder.id } : {}), settings });
			return [folder.id, result.servers.map(server => ({
				id: server.id,
				languageIds: server.languageIds,
			}))] as const;
		}));
		return new AppServerLanguageSupport(new Map(entries));
	}

	get languageIds(): readonly string[] {
		return [...new Set([...this.directories.values()].flatMap(servers => servers.flatMap(server => server.languageIds)))];
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
