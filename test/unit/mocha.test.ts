import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import ts from 'typescript';
import { createServer } from 'node:http';
import { UnitCoverage, normalizeCoverageSourceMaps } from './coverage.ts';
import { withProcessRun } from '../../build/processes.ts';

const desktopDirectory = resolve(import.meta.dirname, '../..');
// Keep synthetic fixtures independent of compiler output size and cleanup.
const outputDirectory = mkdtempSync(join(desktopDirectory, '.build/desktop/runner-fixtures-'));
const compiledDirectory = resolve(desktopDirectory, '.build/desktop/test');
// A Windows process-table request alone can take up to 45 seconds. Leave time
// for the runner to finish the test and close its helper before the outer guard.
const subprocessTimeout = process.platform === 'win32' ? 90_000 : 15_000;
const workerStartupTimeout = process.platform === 'win32' ? 45_000 : 10_000;
const browserFixtureTimeout = '10000';
// The coverage regression exercises c8's full source scan and LCOV reporting.
const coverageReportTimeout = 120_000;
const copiedModules = new Set<string>();
// The real theme preload still needs its emitted module closure in each snapshot.
for (const module of [
	'src/ash/platform/extensionResourceLoader/browser/extensionResourceLoaderService.js',
	'src/ash/platform/extensions/common/extensionApi.js',
	'src/ash/base/common/buffer.js',
	'src/ash/base/common/numbers.js',
	'src/ash/workbench/services/extensions/browser/extensionColorThemeService.js',
]) copyBootstrapModule(resolve(compiledDirectory, module));

function copyBootstrapModule(source: string): void {
	if (copiedModules.has(source)) return;
	copiedModules.add(source);
	const target = resolve(outputDirectory, relative(compiledDirectory, source));
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(source, target);
	if (existsSync(source + '.map')) copyFileSync(source + '.map', target + '.map');
	const module = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
	for (const statement of module.statements) {
		if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
		const specifier = statement.moduleSpecifier;
		if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
			copyBootstrapModule(resolve(dirname(source), specifier.text));
		}
	}
}

const runnerEnvironment = { ...process.env, ASH_UNIT_TEST_OUTPUT_DIRECTORY: outputDirectory };
const parent = join(outputDirectory, 'test/unit');
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(join(parent, 'runner-'));
after(() => rmSync(outputDirectory, { recursive: true, force: true }));
writeFileSync(join(directory, 'first.test.js'), `import { test } from 'mocha';
test('selected behavior', () => {});
test('deliberate failure', () => { throw new Error('runner regression sentinel'); });
test.skip('pending behavior', () => {});
`);
writeFileSync(join(directory, 'second.test.js'), `import { test } from 'mocha';
test('other behavior', () => {});
`);
const first = relative(outputDirectory, join(directory, 'first.test.js')).replaceAll('\\', '/');
const second = relative(outputDirectory, join(directory, 'second.test.js')).replaceAll('\\', '/');
const requiredRunner = join(directory, 'required.ts');
const runnerImport = relative(directory, resolve(desktopDirectory, 'test/unit/mocha.ts')).replaceAll('\\', '/');
writeFileSync(requiredRunner, `import { runUnitTests } from ${JSON.stringify(runnerImport)};
await runUnitTests(${JSON.stringify([first, 'test/unit/missing-required.test.js'])}, false);
`);

function run(args: readonly string[], options: { entrypoint?: string; compiledOutput?: string; timeout?: number; } = {}): { status: number | null; output: string; } {
	const { entrypoint = 'test/unit/run.ts', compiledOutput = outputDirectory, timeout = subprocessTimeout } = options;
	const result = spawnSync(process.execPath, [entrypoint, ...args], {
		cwd: desktopDirectory, encoding: 'utf8', timeout, windowsHide: true, env: { ...runnerEnvironment, ASH_UNIT_TEST_OUTPUT_DIRECTORY: compiledOutput },
	});
	if (result.error) { throw result.error; }
	return { status: result.status, output: result.stdout + result.stderr };
}

test('unit runner sources use syntax supported by Node type stripping', () => {
	// The typecheck also follows frontend type imports whose implementations are
	// compiled separately. Node's syntax restriction belongs to the runner files.
	for (const file of readdirSync(import.meta.dirname).filter(file => file.endsWith('.ts'))) {
		assert.doesNotThrow(() => stripTypeScriptTypes(readFileSync(join(import.meta.dirname, file), 'utf8')), file);
	}
});

test('a missing required file fails even when another required file exists', () => {
	const result = run([], { entrypoint: requiredRunner });
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No compiled unit tests matched the required pattern: test\/unit\/missing-required.test.js/);
	assert.doesNotMatch(result.output, /Mocha: .*tests executed/);
});

test('a filter may select a test in only one of multiple isolated files', () => {
	const result = run(['--run', first, '--run', second, '--grep', '^selected behavior$']);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /1 tests executed across 2 files; 0 failed files/);
});

test('default discovery and source filters include extension-owned units alongside host and architecture units', () => {
	const paths = [
		'src/ash/base/test/common/discovery.test.js',
		'test/architecture/discovery.test.js',
		'extensions/fixture/test/common/discovery.test.js',
	];
	for (const path of paths) {
		const target = join(outputDirectory, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, `import { test } from 'mocha'; test('owner discovery', () => {});`);
	}
	const discovered = run([]);
	assert.equal(discovered.status, 0, discovered.output);
	assert.match(discovered.output, /3 tests executed across 3 files; 0 failed files/);
	const selected = run(['--run', paths[2].replace(/\.js$/u, '.ts')]);
	assert.equal(selected.status, 0, selected.output);
	assert.match(selected.output, /1 tests executed across 1 files; 0 failed files/);
});

test('emitted extensions resolve their own dependencies without exposing them to host tests', () => {
	const extension = join(outputDirectory, 'extensions/json-language-features/localization.js');
	mkdirSync(dirname(extension), { recursive: true });
	writeFileSync(extension, `export { t } from '@vscode/l10n';`);
	const fixture = join(directory, 'extension-dependencies.test.js');
	const specifier = relative(dirname(fixture), extension).replaceAll('\\', '/');
	writeFileSync(fixture, `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'mocha';
import { t } from ${JSON.stringify(specifier)};
test('package dependency scope', () => {
 assert.equal(t('Extension dependency scope'), 'Extension dependency scope');
 assert.throws(() => createRequire(import.meta.url).resolve('@vscode/l10n'), { code: 'MODULE_NOT_FOUND' });
});
`);
	const result = run(['--run', relative(outputDirectory, fixture).replaceAll('\\', '/')]);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /1 tests executed across 1 files; 0 failed files/);
});

test('invalid unit filters fail before copying outputs or starting the selected file', () => {
	for (const args of [['--grep', ''], ['--grep', '   '], ['--grepp', 'selected'], ['--', '--grep', 'selected'], ['--workers', '0'], ['--workers', '-1'], ['--workers', '1.5'], ['--workers', 'NaN']]) {
		const result = run(['--run', first, ...args], { compiledOutput: join(directory, 'missing-compiler-output') });
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /Missing value for --grep|nonempty pattern|Unsupported unit test option|Invalid worker count/);
		assert.doesNotMatch(result.output, /tests executed|runner regression sentinel/);
	}
});

test('affected selection rejects conflicting filters and incomplete revisions before copying outputs', () => {
	for (const args of [['--affected', 'HEAD', '--run', first], ['--affected', 'HEAD', '--runGlob', '**/*.js'], ['--affected', ''], ['--affected', '--grep', 'x'], ['--affected', 'HEAD', '--affected', 'HEAD']]) {
		const result = run(args, { compiledOutput: join(directory, 'missing-compiler-output') });
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /--affected (?:requires|cannot)|Missing value for --affected/u);
		assert.doesNotMatch(result.output, /tests executed|runner regression sentinel/);
	}
});

test('plans source tests without compiler output or preparation in every package mode', () => {
	const path = 'src/ash/base/test/common/event.test.ts';
	for (const mode of [[], ['--compile'], ['--prepared']]) {
		const result = run([...mode, '--plan', '--run', path, '--grep', 'Event'], { compiledOutput: join(directory, 'missing-compiler-output') });
		assert.equal(result.status, 0, result.output);
		assert.match(result.output, /Unit test plan: 1 files; grep: Event; no preparation, compilation or tests executed/u);
		assert.match(result.output, /src\/ash\/base\/test\/common\/event.test.js/u);
		assert.doesNotMatch(result.output, /Mocha:|Preparation exited|tsconfig.test.json/u);
	}
});

test('compiling entries reject invalid and empty selections before preparation', () => {
	for (const args of [['--grepp', 'selected'], ['--runGlob', '**/missing-unit-selection.test.js'], ['--run', 'src/../../outside.test.ts'], ['--run', 'src/missing-unit-selection.test.ts']]) {
		const result = run(['--compile', ...args]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /Unsupported unit test option|No unit tests matched|--run expects|Source unit test does not exist/u);
		assert.doesNotMatch(result.output, /Mocha:|tsconfig.test.json/u);
	}
});

test('source glob planning accepts the package-manager separator and rejects zero matches', () => {
	const result = run(['--compile', '--', '--plan', '--runGlob', '**/localizationService.test.js']);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /Unit test plan: 1 files/u);
	assert.match(result.output, /src\/ash\/.*\/localizationService.test.js/u);
	const missing = run(['--plan', '--runGlob', '**/missing-unit-selection.test.js']);
	assert.equal(missing.status, 1, missing.output);
	assert.match(missing.output, /No unit tests matched the requested files/u);
});

test('exclusive tests fail instead of silently dropping their siblings', () => {
	const exclusive = join(directory, 'exclusive.test.js');
	writeFileSync(exclusive, `import { test } from 'mocha'; test.only('exclusive', () => {}); test('sibling', () => { throw Error('missed sibling'); });`);
	const result = run(['--run', relative(outputDirectory, exclusive).replaceAll('\\', '/')]);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /ERR_MOCHA_FORBIDDEN_EXCLUSIVITY/);
});

test('all selected paths are validated before any test starts', () => {
	const result = run(['--run', first, '--run', 'test/unit/missing.test.js']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /Compiled unit test does not exist/);
	assert.doesNotMatch(result.output, /runner regression sentinel|tests executed/);
});

test('workers overlap isolated files without starting beyond their limit', { timeout: workerStartupTimeout * 2 }, async t => {
	const release = join(directory, 'pool-release');
	writeFileSync(join(directory, 'pool-state.js'), 'export const state = { owner: undefined };');
	const fixtures = [0, 1, 2].map(index => {
		const path = join(directory, `pool-${index}.test.js`);
		writeFileSync(path, `
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
import { state } from './pool-state.js';
test('isolated file ${index}', async () => {
 assert.equal(globalThis.unitPoolOwner, undefined);
 assert.equal(state.owner, undefined);
 globalThis.unitPoolOwner = ${index};
 state.owner = ${index};
 writeFileSync(${JSON.stringify(join(directory, `pool-ready-${index}`))}, 'ready');
 while (!existsSync(${JSON.stringify(release)})) await setTimeout(25);
 assert.equal(globalThis.unitPoolOwner, ${index});
 assert.equal(state.owner, ${index});
});
`);
		return relative(outputDirectory, path).replaceAll('\\', '/');
	});
	const child = spawn(process.execPath, ['test/unit/run.ts', '--workers', '2', ...fixtures.flatMap(path => ['--run', path])], { cwd: desktopDirectory, env: runnerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const stopped = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
	t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped; });
	const deadline = Date.now() + workerStartupTimeout;
	while (![0, 1].every(index => existsSync(join(directory, `pool-ready-${index}`))) && Date.now() < deadline) {
		await new Promise(resolveWait => setTimeout(resolveWait, 25));
		if (child.exitCode !== null) throw new Error(output);
	}
	assert.ok([0, 1].every(index => existsSync(join(directory, `pool-ready-${index}`))), output);
	assert.equal(existsSync(join(directory, 'pool-ready-2')), false, 'A third file exceeded the two-worker limit');
	writeFileSync(release, 'continue');
	assert.equal(await stopped, 0, output);
	assert.match(output, /3 tests executed across 3 files; 0 failed files/);
});

test('isolated files reuse bytecode storage and remove the run-owned cache afterward', () => {
	const marker = join(directory, 'compile-cache.json');
	const fixtures = [0, 1].map(index => {
		const path = join(directory, `compile-cache-${index}.test.js`);
		writeFileSync(path, `
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { getCompileCacheDir } from 'node:module';
import { test } from 'mocha';
test('reuses bytecode ${index}', () => {
 const cache = getCompileCacheDir();
 assert.ok(cache);
 ${index === 0 ? `writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cache, pid: process.pid }));` : `
 const previous = JSON.parse(readFileSync(${JSON.stringify(marker)}, 'utf8'));
 assert.equal(cache, previous.cache);
 assert.notEqual(process.pid, previous.pid);
 assert.ok(readdirSync(cache).length > 0, 'Previous isolated process did not flush bytecode');`}
});
`);
		return relative(outputDirectory, path).replaceAll('\\', '/');
	});
	// This case checks the default run-owned cache rather than caller overrides.
	const env: NodeJS.ProcessEnv = { ...runnerEnvironment };
	for (const name of ['NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'NODE_V8_COVERAGE']) delete env[name];
	const result = spawnSync(process.execPath, ['test/unit/run.ts', '--workers', '1', ...fixtures.flatMap(path => ['--run', path])], { cwd: desktopDirectory, env, encoding: 'utf8', timeout: subprocessTimeout });
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /2 tests executed across 2 files; 0 failed files/);
	assert.equal(existsSync(JSON.parse(readFileSync(marker, 'utf8')).cache), false);
});

test('coverage reporting can retain the compiled snapshot for source-map remapping', () => {
	const env: NodeJS.ProcessEnv = { ...runnerEnvironment, ASH_UNIT_TEST_PRESERVE_OUTPUT: '1' };
	delete env.NODE_V8_COVERAGE;
	const result = spawnSync(process.execPath, ['test/unit/run.ts', '--run', second], {
		cwd: desktopDirectory, encoding: 'utf8', timeout: 15_000, windowsHide: true, env,
	});
	if (result.error) throw result.error;
	assert.equal(result.status, 0, result.stdout + result.stderr);
	const match = /^Preserved unit test output: (.+)$/mu.exec(result.stdout);
	assert.ok(match, result.stdout + result.stderr);
	const snapshot = match[1];
	assert.ok(snapshot.startsWith(join(desktopDirectory, '.build/desktop/test-run-')));
	try {
		assert.equal(existsSync(join(snapshot, second)), true);
	} finally {
		rmSync(snapshot, { recursive: true, force: true });
	}
});

test('the preload resolves editor aliases and ignores static and dynamic CSS imports', () => {
	const path = join(directory, 'loader.test.js');
	writeFileSync(join(directory, 'ignored.css'), '.invalid-javascript { color: red; }');
	writeFileSync(path, `
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { VSBuffer } from 'ash:editor/base/common/buffer.js';
import './ignored.css';
import inlineStyles from './ignored.css?inline';
test('loads through the synchronous hooks', async () => {
 assert.equal(VSBuffer.fromString('loader').toString(), 'loader');
 assert.equal((await import('ash:editor/base/common/buffer.js')).VSBuffer, VSBuffer);
 assert.deepEqual(Object.keys(await import('./ignored.css')), []);
 assert.equal(inlineStyles, '.invalid-javascript { color: red; }');
});
`);
	const result = run(['--run', relative(outputDirectory, path).replaceAll('\\', '/')]);
	assert.equal(result.status, 0, result.output);
	assert.match(result.output, /1 tests executed across 1 files; 0 failed files/);
});

test('a filter matching no tests fails the run', () => {
	const result = run(['--run', first, '--grep', '^missing behavior$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No unit tests executed/);
});

test('coverage validates options before preparation and plans without creating reports', () => {
	const report = join(directory, 'planned-coverage');
	const planned = run(['--compile', '--coverage', '--coveragePath', report, '--plan', '--run', 'src/ash/base/test/common/numbers.test.ts']);
	assert.equal(planned.status, 0, planned.output);
	assert.equal(existsSync(report), false);
	for (const flags of [['--coverageFormats', 'html'], ['--coverage', '--coverageFormats', 'unknown'], ['--coverage', '--coveragePath', directory]]) {
		const result = run(['--compile', '--run', 'src/ash/base/test/common/numbers.test.ts', ...flags]);
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, /require --coverage|Unsupported coverage format|already exists/u);
		assert.doesNotMatch(result.output, /Mocha:|Prepared Ash/u);
	}
});

test('coverage remaps isolated Node output, includes unloaded sources and preserves failed tests', () => {
	const module = 'src/ash/base/common/numbers.js';
	copyBootstrapModule(resolve(compiledDirectory, module));
	const fixture = join(directory, 'coverage.test.js');
	const report = join(directory, 'coverage result');
	const specifier = relative(dirname(fixture), resolve(outputDirectory, module)).replaceAll('\\', '/');
	writeFileSync(fixture, `import { test } from 'mocha'; import assert from 'node:assert/strict'; import { clamp } from ${JSON.stringify(specifier)};
test('covers clamp', () => assert.equal(clamp(10, 0, 5), 5));
test('deliberately fails with coverage', () => { throw new Error('coverage failure sentinel'); });`);
	const result = run(['--run', relative(outputDirectory, fixture).replaceAll('\\', '/'), '--coverage', '--coveragePath', report, '--coverageFormats', 'json-summary,lcov'], { timeout: coverageReportTimeout });
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /coverage failure sentinel/u);
	const summary = JSON.parse(readFileSync(join(report, 'coverage-summary.json'), 'utf8'));
	const numbers = summary[resolve(desktopDirectory, 'src/ash/base/common/numbers.ts')];
	assert.ok(numbers.functions.covered > 0 && numbers.functions.covered < numbers.functions.total);
	assert.ok(Object.keys(summary).some(path => path !== 'total' && summary[path].lines.covered === 0));
	assert.ok(Object.keys(summary).every(path => !path.includes('test-run-') && !path.includes('/test/')));
	assert.match(readFileSync(join(report, 'lcov.info'), 'utf8').replaceAll('\\', '/'), /SF:src\/ash\/base\/common\/numbers.ts/u);
	const metadata = JSON.parse(readFileSync(join(report, 'run.json'), 'utf8'));
	assert.equal(metadata.status, 'failed');
	assert.equal(metadata.reportStatus, 'complete');
	assert.equal(metadata.executedTests, 2);
	assert.equal(metadata.failed.length, 1);
});

test('coverage merges Node and Chromium source counts across navigation and page close', { timeout: subprocessTimeout + coverageReportTimeout }, async t => {
	const coverage = new UnitCoverage({ coverage: true, coveragePath: join(directory, 'browser-coverage'), coverageFormats: ['json-summary'] });
	const assets = join(coverage.directory, 'browser');
	mkdirSync(assets);
	const module = 'src/ash/base/common/numbers.js';
	copyFileSync(resolve(outputDirectory, module), join(assets, 'numbers.js'));
	const map = JSON.parse(readFileSync(resolve(outputDirectory, module + '.map'), 'utf8'));
	map.sources = [relative(assets, resolve(desktopDirectory, 'src/ash/base/common/numbers.ts')).replaceAll('\\', '/')];
	writeFileSync(join(assets, 'numbers.js.map'), JSON.stringify(map));
	normalizeCoverageSourceMaps(assets);
	const server = createServer((request, response) => {
		if (request.url === '/numbers.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(readFileSync(join(assets, 'numbers.js'))); }
		else response.end('<script type="module">import {rot} from "/numbers.js"; window.answer = rot(-1,5);</script>');
	});
	await new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
	t.after(() => new Promise<void>((resolveClosed, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolveClosed()); }));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	const fixture = join(directory, 'browser-coverage.test.js');
	writeFileSync(fixture, `import {suite,test} from 'mocha'; import assert from 'node:assert/strict';
import {clamp} from ${JSON.stringify(pathToFileURL(resolve(outputDirectory, module)).href)};
import {useBrowserTests} from ${JSON.stringify(pathToFileURL(resolve(desktopDirectory, 'test/unit/browser/context.ts')).href)};
suite('source coverage',()=>{const browser=useBrowserTests();test('Node and browser counts',async()=>{
 assert.equal(clamp(10,0,5),5);
 await browser.page.goto('/'); await browser.page.waitForFunction(()=>window.answer===4);
 await browser.page.goto('/again'); await browser.page.waitForFunction(()=>window.answer===4);
 await browser.page.close();
 const extra=await browser.context.newPage();await extra.goto('/');await extra.waitForFunction(()=>window.answer===4);
});});`);
	const result = await promisify(execFile)(process.execPath, ['node_modules/mocha/bin/mocha.js', '--ui', 'tdd', '--timeout', browserFixtureTimeout, fixture], {
		cwd: desktopDirectory, timeout: subprocessTimeout,
		env: { ...runnerEnvironment, ...coverage.environment, ASH_UNIT_COVERAGE_ASSETS: assets, ASH_BROWSER_UNIT_BASE_URL: `http://127.0.0.1:${address.port}`, ASH_BROWSER_UNIT_RESULTS: join(directory, 'browser-results') },
	});
	assert.match(result.stdout, /1 passing/u);
	await withProcessRun(desktopDirectory, async (processRun, environment) => {
		await coverage.report(processRun, environment, outputDirectory, assets, { files: [fixture], failed: [], executedTests: 1, completed: true });
	});
	const summary = JSON.parse(readFileSync(join(coverage.directory, 'coverage-summary.json'), 'utf8'));
	assert.ok(summary[resolve(desktopDirectory, 'src/ash/base/common/numbers.ts')].functions.covered >= 2, 'Both the Node-only clamp and browser-only rot must contribute');
	const metadata = JSON.parse(readFileSync(join(coverage.directory, 'run.json'), 'utf8'));
	assert.ok(metadata.nodeScripts > 0 && metadata.browserScripts > 0);
});

test('an executed assertion failure fails the run and retains its diagnostic', () => {
	const result = run(['--run', first, '--grep', '^deliberate failure$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /runner regression sentinel/);
	assert.match(result.output, /1 tests executed across 1 files; 1 failed files/);
});

for (const origin of ['page', 'popup', 'teardown'] as const) {
	test(`browser ${origin} exceptions fail teardown, retain a trace and leave sibling suites clean`, () => {
		const fixture = join(directory, `browser-errors-${origin}.test.js`);
		const results = join(directory, `browser-errors-${origin}`);
		writeFileSync(fixture, `
import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { useBrowserTests } from ${JSON.stringify(pathToFileURL(resolve(desktopDirectory, 'test/unit/browser/context.ts')).href)};
process.env.ASH_BROWSER_UNIT_BASE_URL = 'http://127.0.0.1:1';
process.env.ASH_BROWSER_UNIT_RESULTS = ${JSON.stringify(results)};
suite('browser exception', () => {
 const browser = useBrowserTests();
 async function provoke() {
  const page = ${origin === 'popup' ? 'await browser.context.newPage()' : 'browser.page'};
  const error = page.waitForEvent('pageerror');
  await page.evaluate(() => { setTimeout(() => { throw new Error('browser ${origin} sentinel'); }, 0); });
  assert.equal((await error).message, 'browser ${origin} sentinel');
 }
 ${origin === 'teardown' ? 'teardown(provoke);' : ''}
 test('reaches the deliberate exception', async () => {
  ${origin === 'teardown' ? '' : 'await provoke();'}
 });
});
suite('clean sibling', () => {
 const browser = useBrowserTests();
 test('has no inherited exceptions', async () => {
  await browser.page.setContent('<button>Clean sibling</button>');
  assert.equal(await browser.page.locator('button').textContent(), 'Clean sibling');
 });
});
`);
		const result = run(['--ui', 'tdd', '--timeout', browserFixtureTimeout, fixture], { entrypoint: 'node_modules/mocha/bin/mocha.js' });
		assert.equal(result.status, 1, result.output);
		assert.match(result.output, new RegExp(`browser ${origin} sentinel`));
		assert.match(result.output, /Unhandled browser errors/);
		assert.match(result.output, /has no inherited exceptions/);
		assert.match(result.output, /1 failing/);
		assert.equal(readdirSync(results, { recursive: true }).filter(path => path.toString().endsWith('trace.zip')).length, 1);
	});
}

test('a selection containing only skipped tests fails the run', () => {
	const result = run(['--run', first, '--grep', '^pending behavior$']);
	assert.equal(result.status, 1, result.output);
	assert.match(result.output, /No unit tests executed/);
});

test('a running suite retains its modules after the shared compiler output is cleaned', { timeout: workerStartupTimeout * 2 }, async t => {
	const ready = join(directory, 'snapshot-ready');
	const release = join(directory, 'snapshot-release');
	const waiting = join(directory, 'snapshot.test.js');
	const dependency = join(directory, 'snapshot-dependency.js');
	writeFileSync(dependency, 'export const value = 42;');
	writeFileSync(waiting, `
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { test } from 'mocha';
test('retains a dependency loaded after cleanup', async () => {
 writeFileSync(${JSON.stringify(ready)}, 'ready');
 while (!existsSync(${JSON.stringify(release)})) await setTimeout(25);
 assert.equal((await import('./snapshot-dependency.js')).value, 42);
});
`);
	const child = spawn(process.execPath, ['test/unit/run.ts', '--run', relative(outputDirectory, waiting).replaceAll('\\', '/')], { cwd: desktopDirectory, env: runnerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.stderr.on('data', chunk => { output += chunk; });
	const stopped = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
	t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await stopped; });
	const deadline = Date.now() + workerStartupTimeout;
	while (!existsSync(ready) && Date.now() < deadline) {
		await new Promise(resolveWait => setTimeout(resolveWait, 25));
		if (child.exitCode !== null) throw new Error(output);
	}
	assert.ok(existsSync(ready), output);
	rmSync(waiting);
	rmSync(dependency);
	writeFileSync(release, 'continue');
	assert.equal(await stopped, 0, output);
	assert.match(output, /1 tests executed across 1 files; 0 failed files/);
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
	test(`${signal} stops all concurrent Mocha descendants and leaves queued files unstarted`, { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
		const markers = [0, 1].map(index => join(directory, `ready-${signal}-${index}`));
		const later = join(directory, `later-${signal}`);
		const waiting = [0, 1].map(index => join(directory, `0${index}-waiting-${signal}.test.js`));
		const following = join(directory, `02-following-${signal}.test.js`);
		for (const [index, path] of waiting.entries()) {
			const marker = markers[index];
			writeFileSync(path, `
import { test } from 'mocha';
import { spawn } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
test('waiting', async function() {
 this.timeout(120000);
 const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); process.send(process.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
 await new Promise(resolveReady => child.once('message', resolveReady));
 // The parent polls for existence; expose the marker only after its JSON is complete.
 await writeFile(${JSON.stringify(marker + '.tmp')}, JSON.stringify([process.pid, child.pid]));
 await rename(${JSON.stringify(marker + '.tmp')}, ${JSON.stringify(marker)});
 await new Promise(() => {});
});
`);
		}
		writeFileSync(following, `import { test } from 'mocha'; import { writeFileSync } from 'node:fs'; test('must not start', () => writeFileSync(${JSON.stringify(later)}, 'ran'));`);
		const paths = [...waiting, following].map(path => relative(outputDirectory, path).replaceAll('\\', '/'));
		const child = spawn(process.execPath, ['test/unit/run.ts', '--workers', '2', ...paths.flatMap(path => ['--run', path])], { cwd: desktopDirectory, env: runnerEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { output += chunk; });
		const stopped = new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); });
		let pids: number[] = [];
		t.after(async () => {
			for (const pid of [child.pid, ...pids]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
			await stopped;
		});
		const deadline = Date.now() + 10_000;
		while (!markers.every(marker => existsSync(marker)) && Date.now() < deadline) {
			await new Promise(resolveWait => setTimeout(resolveWait, 25));
			if (child.exitCode !== null) throw new Error(output);
		}
		assert.ok(markers.every(marker => existsSync(marker)), output);
		pids = (await Promise.all(markers.map(async marker => JSON.parse(await readFile(marker, 'utf8')) as number[]))).flat();
		child.kill(signal);
		assert.equal(await stopped, code, output);
		assert.equal(existsSync(later), false, 'Another test file started after cancellation');
		for (const pid of pids) {
			const result = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=']).catch(error => { if (error.code === 1) return { stdout: '' }; throw error; });
			assert.ok(!result.stdout.trim() || result.stdout.trim().startsWith('Z'), `Leaked Mocha PID ${pid}`);
		}
	});
}
