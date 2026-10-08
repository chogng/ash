import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Undefined selects full acceptance; PRs compare against their exact base. */
export function ciChanges(root: string): string[] | undefined {
	if (process.env.GITHUB_EVENT_NAME !== 'pull_request') { return undefined; }
	const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
	const base = event.pull_request?.base?.sha;
	if (typeof base !== 'string' || !/^[a-f0-9]{40}$/.test(base)) { throw new Error('PR checks require their exact base SHA'); }
	execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], { cwd: root, stdio: 'inherit' });
	return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
}
