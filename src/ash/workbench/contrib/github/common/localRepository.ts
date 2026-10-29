import { match } from '../../../../base/common/glob.js';
import type { GitHubBranchProtection } from '../../../../platform/github/common/githubService.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
export interface RepositoryIdentity {
	readonly provider: string;
	readonly host: string;
	readonly owner: string;
	readonly repository: string;
}
interface RepositoryRemote {
	readonly name: string;
	readonly identity?: RepositoryIdentity;
}
export interface LocalRepository {
	readonly id: string;
	readonly label: string;
	readonly path: string;
	readonly root: URI;
	readonly head: {
		readonly type: string;
		readonly name: string;
		readonly objectId: string;
		readonly upstream?: { readonly name: string; readonly ahead: number; readonly behind: number };
	};
	readonly uncommittedChanges?: number;
	readonly remotes: readonly RepositoryRemote[];
}
/** Optional provider command contract consumed by GitHub, independent of its implementation. */
export async function readLocalRepositories(commands: ICommandService): Promise<readonly LocalRepository[]> {
	let result: unknown;
	try {
		// Extension commands belong to the window's command service, not the global contribution registry.
		result = await commands.executeCommand('git.getRepositoryContexts');
	} catch (error) {
		if (error instanceof Error && error.message === 'Unknown command: git.getRepositoryContexts') return [];
		throw error;
	}
	if (!Array.isArray(result) || result.length > 128) {
		throw new TypeError('Invalid repository contexts');
	}
	const text = (value: unknown): string => {
		if (typeof value !== 'string' || value.length > 32768 || value.includes('\0')) {
			throw new TypeError('Invalid repository context text');
		}
		return value;
	};
	const count = (value: unknown): number => {
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
			throw new TypeError('Invalid repository context count');
		}
		return value;
	};
	return result.map(value => {
		if (!value || typeof value !== 'object' || !value.head || !Array.isArray(value.remotes)) {
			throw new TypeError('Invalid repository context');
		}
		const upstream: unknown = value.head.upstream;
		if (upstream !== undefined && upstream !== null && (typeof upstream !== 'object' || Array.isArray(upstream))) {
			throw new TypeError('Invalid repository upstream');
		}
		const tracking = upstream as { name: unknown; ahead: unknown; behind: unknown } | null | undefined;
		return {
			id: text(value.id),
			label: text(value.label),
			path: text(value.path),
			root: URI.parse(text(value.root)),
			head: {
				type: text(value.head.type),
				name: text(value.head.name ?? ''),
				objectId: text(value.head.objectId ?? ''),
				...(tracking
					? {
							upstream: {
								name: text(tracking.name),
								ahead: count(tracking.ahead),
								behind: count(tracking.behind),
							},
						}
					: {}),
			},
			...(value.uncommittedChanges === undefined ? {} : { uncommittedChanges: count(value.uncommittedChanges) }),
			remotes: value.remotes.map(
				(remote: {
					name: unknown;
					identity?: { provider: unknown; host: unknown; owner: unknown; repository: unknown };
				}) => ({
					name: text(remote.name),
					...(remote.identity
						? {
								identity: {
									provider: text(remote.identity.provider),
									host: text(remote.identity.host),
									owner: text(remote.identity.owner),
									repository: text(remote.identity.repository),
								},
							}
						: {}),
				}),
			),
		};
	});
}

/** Rules in different rulesets are additive; exclusions apply only to their own rule. */
export function isGitHubBranchProtected(branch: string, protection: GitHubBranchProtection): boolean {
	return protection.rules.some(
		rule =>
			rule.include.some(pattern => match(pattern, branch)) &&
			!rule.exclude.some(pattern => match(pattern, branch)),
	);
}
/** Prefer the tracked remote to avoid sharing a fork's commit through the upstream repository. */
export function githubRemotes(repository: LocalRepository): LocalRepository['remotes'] {
	return repository.remotes
		.filter(remote => remote.identity?.provider === 'github')
		.sort(
			(a, b) =>
				Number(repository.head.upstream?.name.startsWith(`${b.name}/`) ?? false) -
				Number(repository.head.upstream?.name.startsWith(`${a.name}/`) ?? false),
		);
}
