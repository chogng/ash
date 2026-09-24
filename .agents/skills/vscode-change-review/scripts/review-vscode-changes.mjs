import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const skillRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(skillRoot, '../../..');
const checkpointPath = resolve(skillRoot, 'checkpoint.json');
const checkpoint = JSON.parse(readFileSync(checkpointPath, 'utf8'));
const options = readOptions(process.argv.slice(2));
const upstreamRoot = resolve(repositoryRoot, checkpoint.upstreamRepository);

if (options.help) {
	process.stdout.write('Usage: node .agents/skills/vscode-change-review/scripts/review-vscode-changes.mjs [--check] [--from=<commit>] [--to=<commit>] [--json]\n');
	process.exit(0);
}

const stateErrors = validateCheckpoint(checkpoint, upstreamRoot);
if (stateErrors.length > 0) {
	for (const error of stateErrors) process.stderr.write(`${error}\n`);
	process.exit(1);
}

if (options.check) {
	printState(checkpoint);
	process.exit(0);
}

const fromInput = options.from ?? checkpoint.reviewed?.commit;
if (!fromInput) {
	process.stderr.write('No reviewed checkpoint exists. Choose a trusted baseline and rerun with --from=<commit>.\n');
	process.exit(2);
}

const from = resolveCommit(upstreamRoot, fromInput);
const to = resolveCommit(upstreamRoot, options.to ?? 'HEAD');
assertAncestor(upstreamRoot, from, to);

const commits = readCommits(upstreamRoot, from, to);
const result = {
	upstreamRepository: checkpoint.upstreamRepository,
	from,
	to,
	commitCount: commits.length,
	pendingCount: checkpoint.pending.length,
	commits,
};

if (options.json) {
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
	printResult(result, checkpoint);
}

function readOptions(args) {
	const result = { check: false, json: false, help: false, from: undefined, to: undefined };
	for (const argument of args) {
		if (argument === '--check') result.check = true;
		else if (argument === '--json') result.json = true;
		else if (argument === '--help') result.help = true;
		else if (argument.startsWith('--from=')) result.from = argument.slice('--from='.length);
		else if (argument.startsWith('--to=')) result.to = argument.slice('--to='.length);
		else throw new Error(`Unknown argument: ${argument}`);
	}
	return result;
}

function validateCheckpoint(state, gitRoot) {
	const errors = [];
	if (state.schemaVersion !== 1) errors.push('checkpoint.json schemaVersion must be 1.');
	if (typeof state.upstreamRepository !== 'string' || !state.upstreamRepository) errors.push('checkpoint.json upstreamRepository must be a non-empty string.');
	if (!Array.isArray(state.pending)) errors.push('checkpoint.json pending must be an array.');
	for (const field of ['reviewed', 'aligned']) {
		const value = state[field];
		if (value !== null && (typeof value !== 'object' || !isCommit(value.commit) || typeof value.date !== 'string')) {
			errors.push(`checkpoint.json ${field} must be null or contain a full commit and date.`);
		}
	}
	if (errors.length > 0) return errors;

	try {
		runGit(gitRoot, ['rev-parse', '--is-inside-work-tree']);
		for (const field of ['reviewed', 'aligned']) {
			if (state[field]) resolveCommit(gitRoot, state[field].commit);
		}
		if (state.aligned && !state.reviewed) errors.push('aligned cannot exist without reviewed.');
		if (state.aligned && state.reviewed) assertAncestor(gitRoot, state.aligned.commit, state.reviewed.commit);
	} catch (error) {
		errors.push(error.message);
	}

	const ids = new Set();
	for (const finding of Array.isArray(state.pending) ? state.pending : []) {
		if (!finding || typeof finding !== 'object') {
			errors.push('Each pending finding must be an object.');
			continue;
		}
		if (typeof finding.id !== 'string' || !finding.id) errors.push('Each pending finding needs a non-empty id.');
		else if (ids.has(finding.id)) errors.push(`Duplicate pending id: ${finding.id}`);
		else ids.add(finding.id);
		if (!isCommit(finding.introducedBy)) errors.push(`Pending ${finding.id ?? '<unknown>'} needs a full introducedBy commit.`);
		if (!['apply', 'decision'].includes(finding.kind)) errors.push(`Pending ${finding.id ?? '<unknown>'} kind must be apply or decision.`);
		if (!Array.isArray(finding.upstreamPaths) || !Array.isArray(finding.ashPaths)) errors.push(`Pending ${finding.id ?? '<unknown>'} paths must be arrays.`);
		if (typeof finding.summary !== 'string' || !finding.summary) errors.push(`Pending ${finding.id ?? '<unknown>'} needs a summary.`);
		if (isCommit(finding.introducedBy)) {
			try {
				resolveCommit(gitRoot, finding.introducedBy);
				if (state.reviewed) assertAncestor(gitRoot, finding.introducedBy, state.reviewed.commit);
				if (state.aligned) {
					const result = spawnSync('git', ['merge-base', '--is-ancestor', finding.introducedBy, state.aligned.commit], { cwd: gitRoot, encoding: 'utf8', shell: false });
					if (result.status === 0) errors.push(`Pending ${finding.id ?? '<unknown>'} is already inside the aligned checkpoint.`);
				}
			} catch (error) {
				errors.push(error.message);
			}
		}
	}
	return errors;
}

function readCommits(gitRoot, from, to) {
	if (from === to) return [];
	const records = runGit(gitRoot, ['log', '--reverse', '--format=%H%x1f%aI%x1f%s', `${from}..${to}`])
		.split(/\r?\n/u)
		.filter(Boolean);
	return records.map(record => {
		const [commit, date, subject] = record.split('\x1f');
		const changes = runGit(gitRoot, ['show', '--format=', '--name-status', '-M', commit])
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(readChange);
		return { commit, date, subject, changes };
	});
}

function readChange(line) {
	const parts = line.split('\t');
	const status = parts[0];
	const paths = parts.slice(1);
	return { status, paths, scopes: [...new Set(paths.map(readScope))] };
}

function readScope(path) {
	const match = /^src\/vs\/(base|platform|editor|workbench|code|sessions)(?:\/|$)/u.exec(path);
	return match ? `app-ts/src/ash/${match[1]}` : 'other';
}

function printResult(result, state) {
	process.stdout.write(`VS Code range: ${result.from}..${result.to}\n`);
	process.stdout.write(`commits: ${result.commitCount}\n`);
	process.stdout.write(`existing pending findings: ${result.pendingCount}\n`);
	for (const commit of result.commits) {
		process.stdout.write(`\n${commit.commit} ${commit.date} ${commit.subject}\n`);
		for (const change of commit.changes) {
			process.stdout.write(`  ${change.status.padEnd(4)} ${change.paths.join(' -> ')} [${change.scopes.join(', ')}]\n`);
		}
	}
	if (result.commitCount === 0) process.stdout.write('No new commits in the selected range.\n');
	process.stdout.write(`\nreviewed: ${state.reviewed?.commit ?? 'not set'}\n`);
	process.stdout.write(`aligned:  ${state.aligned?.commit ?? 'not set'}\n`);
}

function printState(state) {
	process.stdout.write(`checkpoint valid\n`);
	process.stdout.write(`reviewed: ${state.reviewed?.commit ?? 'not set'}\n`);
	process.stdout.write(`aligned:  ${state.aligned?.commit ?? 'not set'}\n`);
	process.stdout.write(`pending:  ${state.pending.length}\n`);
}

function resolveCommit(gitRoot, revision) {
	return runGit(gitRoot, ['rev-parse', '--verify', `${revision}^{commit}`]).trim();
}

function assertAncestor(gitRoot, ancestor, descendant) {
	const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: gitRoot, encoding: 'utf8', shell: false });
	if (result.status !== 0) throw new Error(`${ancestor} is not an ancestor of ${descendant}. Choose a valid linear review range.`);
}

function runGit(gitRoot, args) {
	const result = spawnSync('git', args, { cwd: gitRoot, encoding: 'utf8', shell: false, maxBuffer: 64 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(result.stderr?.trim() || `git ${args[0]} failed with exit code ${result.status}`);
	return result.stdout ?? '';
}

function isCommit(value) {
	return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}
