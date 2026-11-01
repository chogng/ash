import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { planAffectedTests as analyze } from './impact.ts';

type Options = NonNullable<Parameters<typeof analyze>[3]>;
type TestPlan = ReturnType<typeof analyze>;

/** Keep the TypeScript analyzer in pinned Bun; Mocha and its preloads stay in Node. */
export function planAffectedTests(root: string, base: string, tests: readonly string[], options: Options = {}): TestPlan {
	// Invalid revisions are user errors, not an analyzer failure that should start
	// the full suite. Validate before the subprocess boundary can fail closed.
	for (const ref of [base, ...(options.head ? [options.head] : [])]) {
		execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
	}
	try {
		const output = execFileSync(resolve(import.meta.dirname, '../../node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun'), [fileURLToPath(import.meta.url)], {
			cwd: root,
			input: JSON.stringify({ root, base, tests, options }),
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const plan: unknown = JSON.parse(output);
		const allowed = new Set(tests);
		if (!isObject(plan) || typeof plan.full !== 'boolean' || typeof plan.reason !== 'string' || !isStrings(plan.files)
			|| new Set(plan.files).size !== plan.files.length || plan.files.some(file => !allowed.has(file))
			|| (plan.full && (plan.files.length !== tests.length || plan.files.some((file, index) => file !== tests[index])))) {
			throw new Error('invalid impact worker result');
		}
		return { files: plan.files, full: plan.full, reason: plan.reason };
	} catch (error) {
		return { files: tests, full: true, reason: `dependency analysis worker unavailable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { readFileSync } = await import('node:fs');
	const request: unknown = JSON.parse(readFileSync(0, 'utf8'));
	if (!isObject(request) || typeof request.root !== 'string' || typeof request.base !== 'string' || !isStrings(request.tests)
		|| !isObject(request.options) || (request.options.head !== undefined && typeof request.options.head !== 'string')
		|| (request.options.preloads !== undefined && !isStrings(request.options.preloads))) {
		throw new Error('invalid impact worker request');
	}
	const { planAffectedTests: analyze } = await import('./impact.ts');
	process.stdout.write(JSON.stringify(analyze(request.root, request.base, request.tests, {
		head: request.options.head as string | undefined,
		preloads: request.options.preloads as readonly string[] | undefined,
	})));
}
