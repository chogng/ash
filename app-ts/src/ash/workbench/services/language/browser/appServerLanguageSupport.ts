import type { ILanguageApi } from '../../../../platform/language/common/languageApi.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

interface LanguageServer {
	readonly id: string;
	readonly languageIds: readonly string[];
}

export class AppServerLanguageSupport {
	constructor(private readonly directories: ReadonlyMap<string, readonly LanguageServer[]> = new Map()) {}

	static async read(api: ILanguageApi, workspace: IWorkspaceContextService): Promise<AppServerLanguageSupport> {
		const folders = workspace.getWorkspace().folders;
		const entries = await Promise.all(folders.map(async folder => {
			const result = await api.servers(folders.length > 1 ? { dirId: folder.id } : {});
			return [folder.id, result.servers.map(server => ({
				id: server.id,
				languageIds: server.languageIds.map(languageId => languageId === 'shell' ? 'shellscript' : languageId),
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
