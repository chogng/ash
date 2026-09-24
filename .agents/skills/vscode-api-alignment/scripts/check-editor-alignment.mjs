import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const full = process.argv.includes('--full');
const structureOnly = process.argv.includes('--structure-only');
const testArgument = process.argv.slice(2).find(argument => argument.startsWith('--test='));
const testMode = testArgument?.slice('--test='.length);
const knownArguments = new Set(['--full', '--structure-only', '--help']);
const unknownArguments = process.argv.slice(2).filter(argument => !knownArguments.has(argument) && !argument.startsWith('--test='));
const knownTestModes = new Set(['unit', 'browser', 'all']);

if (process.argv.includes('--help')) {
	process.stdout.write(`Usage: node .agents/skills/vscode-api-alignment/scripts/check-editor-alignment.mjs [--full] [--structure-only]\n\n`);
	process.stdout.write(`  --full            Print complete file-set, CSS ownership, and member reports.\n`);
	process.stdout.write(`  --structure-only  Skip repository typecheck and behavior tests.\n`);
	process.stdout.write(`  --test=unit       Run Editor unit tests.\n`);
	process.stdout.write(`  --test=browser    Run Editor browser behavior tests.\n`);
	process.stdout.write(`  --test=all        Run both Editor test groups.\n`);
	process.exit(0);
}

if (unknownArguments.length > 0) {
	process.stderr.write(`Unknown arguments: ${unknownArguments.join(', ')}\n`);
	process.exit(2);
}

if (testMode && !knownTestModes.has(testMode)) {
	process.stderr.write(`Unknown test mode: ${testMode}\n`);
	process.exit(2);
}

const initialJavaScript = readUntrackedJavaScript();
let failed = false;

failed = !runLedgerCheck() || failed;
failed = !runFileSetAudit() || failed;
failed = !runCssOwnershipAudit() || failed;
failed = !runMemberAudit() || failed;
failed = !runDiffCheck() || failed;
if (!structureOnly) {
	failed = !runTypecheck() || failed;
	if (testMode) {
		failed = !runBehaviorTests() || failed;
	} else {
		process.stdout.write(`\n[behavior tests] not selected; this is not final behavior verification\n`);
	}
}

const finalJavaScript = readUntrackedJavaScript();
const generatedJavaScript = [...finalJavaScript].filter(path => !initialJavaScript.has(path));
if (generatedJavaScript.length > 0) {
	failed = true;
	process.stderr.write(`\n[generated JavaScript] FAILED\n`);
	process.stderr.write(`The check created ${generatedJavaScript.length} untracked JavaScript file(s):\n`);
	for (const path of generatedJavaScript) process.stderr.write(`  ${path}\n`);
} else {
	process.stdout.write(`\n[generated JavaScript] no new untracked .js files\n`);
}

process.exitCode = failed ? 1 : 0;

function runLedgerCheck() {
	const result = runNodeScript('verify-editor-api-ledger.mjs');
	printResult('ledger', result);
	return result.status === 0;
}

function runFileSetAudit() {
	const result = runNodeScript('audit-editor-file-set.mjs');
	process.stdout.write(`\n[file set]${result.status === 0 ? '' : ' FAILED'}\n`);
	if (full || result.status !== 0) {
		process.stdout.write(result.stdout);
	} else {
		const summary = result.stdout.split(/\r?\n/u).filter(line => /^(same-path|case-mismatch|local-only|upstream-only|local production files|upstream production files):/u.test(line));
		process.stdout.write(`${summary.join('\n')}\n`);
	}
	if (result.stderr) process.stderr.write(result.stderr);
	return result.status === 0;
}

function runCssOwnershipAudit() {
	const result = runNodeScript('audit-editor-css-ownership.mjs', full ? ['--full'] : []);
	printResult('CSS ownership', result);
	return result.status === 0;
}

function runMemberAudit() {
	const result = runNodeScript('compare-editor-api-members.mjs');
	process.stdout.write(`\n[API members]${result.status === 0 ? '' : ' FAILED'}\n`);
	if (full || result.status !== 0) {
		process.stdout.write(result.stdout);
	} else {
		const records = parseMemberRecords(result.stdout);
		const missing = records.filter(record => record.kind.startsWith('missing-'));
		const exact = records.filter(record => record.difference === 0 && !record.kind.startsWith('missing-'));
		const different = records.filter(record => record.difference > 0 && !record.kind.startsWith('missing-'));
		process.stdout.write(`exact member names: ${exact.length}\n`);
		process.stdout.write(`member differences: ${different.length}\n`);
		process.stdout.write(`missing files or declarations: ${missing.length}\n`);
		for (const record of [...missing, ...different].slice(0, 20)) process.stdout.write(`${record.lines.join('\n')}\n`);
		if (missing.length + different.length > 20) process.stdout.write(`... ${missing.length + different.length - 20} more; rerun with --full\n`);
	}
	if (result.stderr) process.stderr.write(result.stderr);
	return result.status === 0;
}

function runDiffCheck() {
	const result = run('git', ['diff', '--check']);
	printResult('diff check', result);
	return result.status === 0;
}

function runTypecheck() {
	const packagePath = resolve(repositoryRoot, 'app-ts/package.json');
	const rendererConfigPath = resolve(repositoryRoot, 'app-ts/tsconfig.renderer.json');
	const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
	const rendererConfig = JSON.parse(readFileSync(rendererConfigPath, 'utf8'));
	const command = packageJson.scripts?.['typecheck:stanza'];
	process.stdout.write(`\n[typecheck:stanza]\n`);
	if (rendererConfig.compilerOptions?.noEmit !== true) {
		process.stderr.write(`Refusing to run: app-ts/tsconfig.renderer.json must set compilerOptions.noEmit to true.\n`);
		return false;
	}
	if (typeof command !== 'string') {
		process.stderr.write(`Refusing to run: app-ts/package.json must define typecheck:stanza.\n`);
		return false;
	}
	process.stdout.write(`repository script: ${command}\n`);
	const result = process.platform === 'win32'
		? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm --dir app-ts run typecheck:stanza'])
		: run('pnpm', ['--dir', 'app-ts', 'run', 'typecheck:stanza']);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) process.stderr.write(`[typecheck:stanza] FAILED with exit code ${result.status}\n`);
	return result.status === 0;
}

function runBehaviorTests() {
	const script = {
		unit: 'test:editor:unit',
		browser: 'test:editor:browser',
		all: 'test:editor',
	}[testMode];
	process.stdout.write(`\n[behavior tests: ${testMode}]\n`);
	const result = process.platform === 'win32'
		? run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `pnpm --dir app-ts run ${script}`])
		: run('pnpm', ['--dir', 'app-ts', 'run', script]);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	if (result.status !== 0) process.stderr.write(`[behavior tests: ${testMode}] FAILED with exit code ${result.status}\n`);
	return result.status === 0;
}

function runNodeScript(name, args = []) {
	return run(process.execPath, [resolve(import.meta.dirname, name), ...args]);
}

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		shell: false,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? '',
		stderr: result.error ? `${result.stderr ?? ''}${result.error.message}\n` : result.stderr ?? '',
	};
}

function printResult(label, result) {
	process.stdout.write(`\n[${label}]${result.status === 0 ? '' : ' FAILED'}\n`);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
}

function readUntrackedJavaScript() {
	const result = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
	if (result.status !== 0) throw new Error(result.stderr || 'Unable to read Git status');
	return new Set(result.stdout
		.split(/\r?\n/u)
		.filter(line => line.startsWith('?? ') && line.slice(3).endsWith('.js'))
		.map(line => line.slice(3)));
}

function parseMemberRecords(output) {
	const records = [];
	let current;
	for (const line of output.split(/\r?\n/u)) {
		const match = /^\s*(\d+)\s+(.+?)\s+\[([^\]]+)\]$/u.exec(line);
		if (match) {
			current = { difference: Number(match[1]), target: match[2], kind: match[3], lines: [line] };
			records.push(current);
		} else if (current && /^\s+(missing|extra):/u.test(line)) {
			current.lines.push(line);
		}
	}
	return records;
}
