import type { URI } from '../../../base/common/uri.js';

export type GitHubLinkTarget =
	| { readonly kind: 'repository'; readonly owner: string; readonly repo: string; }
	| { readonly kind: 'issue' | 'pullRequest'; readonly owner: string; readonly repo: string; readonly number: number; };

/** Parses GitHub resource paths after the caller has selected the host. */
export function parseGitHubLinkTarget(resource: URI): GitHubLinkTarget | undefined {
	if (resource.scheme !== 'https') return undefined;
	const match = /^\/([\w.-]+)\/([\w.-]+)(?:\/(issues|pull)\/([1-9]\d*)|\/?)$/u.exec(resource.path);
	if (!match) return undefined;
	const [, owner, repo, section, index] = match;
	if (!section) return { kind: 'repository', owner, repo };
	const number = Number(index);
	return Number.isSafeInteger(number) ? { kind: section === 'issues' ? 'issue' : 'pullRequest', owner, repo, number } : undefined;
}
