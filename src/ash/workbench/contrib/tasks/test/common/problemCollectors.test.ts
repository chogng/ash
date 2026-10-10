import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { MarkerService } from '../../../../../platform/markers/common/markers.js';
import { WatchingProblemCollector } from '../../common/problemCollectors.js';
import { parseProblemMatchers, registerProblemMatcherContributions } from '../../common/problemMatcher.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { DeferredPromise } from '../../../../../base/common/async.js';

suite('Task problem collection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('core compiler and lint matchers publish tool locations, severity and codes', () => {
		const cases = [
			{ name: '$msCompile', lines: ['/workspace/build.cs(4,5): category fatal error CS7: MICROSOFT', '/workspace/build.cs: warning : NO_LOCATION'], expected: [['MICROSOFT', 'error', 'CS7', '/workspace/build.cs', 3, 4, 3, 4]] },
			{ name: '$msCompile', lines: ['  2>c:/src/build.cs(6,7,8,9): category info INF3: BUILD_PREFIX', 'warning: NO_ORIGIN'], expected: [['BUILD_PREFIX', 'information', 'INF3', '/c:/src/build.cs', 5, 6, 7, 8]] },
			{ name: '$gulp-tsc', lines: ['src/build.ts(2,4): 102 BUILD_TS'], expected: [['BUILD_TS', 'error', '102', '/workspace/src/build.ts', 1, 3, 1, 3]] },
			{ name: '$lessCompile', lines: ['LESS_LEGACY in file /workspace/style.less line no. 3'], expected: [['LESS_LEGACY', 'error', undefined, '/workspace/style.less', 2, 0, 2, 2147483646]] },
			{ name: '$go', lines: ['go build: main.go:4:5: GO_COLUMN', 'other.go:6: GO_LINE', 'C:\\src\\main.go:7:8: GO_WINDOWS'], expected: [['GO_COLUMN', 'error', undefined, '/workspace/main.go', 3, 4, 3, 4], ['GO_LINE', 'error', undefined, '/workspace/other.go', 5, 0, 5, 2147483646], ['GO_WINDOWS', 'error', undefined, '/workspace/C:/src/main.go', 6, 7, 6, 7]] },
			{ name: '$jshint', lines: ['/workspace/lint.js: line 2, col 3, JSHINT_WARNING (W033)', '/workspace/lint.js: line 4, col 5, JSHINT_ERROR (E003)'], expected: [['JSHINT_WARNING', 'warning', '033', '/workspace/lint.js', 1, 2, 1, 2], ['JSHINT_ERROR', 'error', '003', '/workspace/lint.js', 3, 4, 3, 4]] },
			{ name: '$eslint-compact', lines: ['/workspace/lint.js: line 2, col 3, Warning - ESLINT_COMPACT (semi)'], expected: [['ESLINT_COMPACT', 'warning', 'semi', '/workspace/lint.js', 1, 2, 1, 2]] },
			{ name: '$eslint-stylish', lines: ['/workspace/lint.js', '  2:3 warning ESLINT_RULE  semi', '  4:5 error ESLINT_NO_RULE'], expected: [['ESLINT_RULE', 'warning', 'semi', '/workspace/lint.js', 1, 2, 1, 2], ['ESLINT_NO_RULE', 'error', undefined, '/workspace/lint.js', 3, 4, 3, 4]] },
			{ name: '$jshint-stylish', lines: ['/workspace/lint.js', '  line 2 col 3 JSHINT_CODE (W033)', '  line 4 col 5 JSHINT_NO_CODE'], expected: [['JSHINT_CODE', 'warning', '033', '/workspace/lint.js', 1, 2, 1, 2], ['JSHINT_NO_CODE', 'error', undefined, '/workspace/lint.js', 3, 4, 3, 4]] },
		];
		for (const value of cases) {
			using markers = new MarkerService();
			using collector = new WatchingProblemCollector(parseProblemMatchers([value.name]), URI.file('/workspace'), markers, value.name, () => false);
			collector.accept(new TextEncoder().encode(value.lines.join('\n')));
			collector.done();
			assert.deepEqual(markers.getAll().map(marker => [marker.message, marker.severity, marker.code, marker.resource.path, marker.range.start.lineIndex, marker.range.start.columnIndex, marker.range.end.lineIndex, marker.range.end.columnIndex]), value.expected, value.name);
		}
	});

	test('captured severity names and uppercase shorthand retain the configured fallback', () => {
		const cases = [['Error', 'error'], ['WARN', 'warning'], ['Warning', 'warning'], ['Info', 'information'], ['Hint', 'information'], ['Note', 'information'], ['E', 'error'], ['W', 'warning'], ['I', 'information'], ['e', 'warning'], ['i', 'warning'], ['fatal error', 'warning'], ['unknown', 'warning']] as const;
		for (const [severity, expected] of cases) {
			using markers = new MarkerService();
			using collector = new WatchingProblemCollector(parseProblemMatchers([{ severity: 'warning', pattern: { regexp: '^(.+)\\|([^|]+) (.+)$', file: 1, line: 3, severity: 2, message: 0 } }]), URI.file('/workspace'), markers, 'severity', () => false);
			collector.processLine(`main.ts|${severity} 2`);
			assert.equal(markers.getAll()[0].severity, expected, severity);
			assert.equal(collector.hasErrors, expected === 'error', severity);
		}
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ base: '$msCompile', severity: 'warning' }]), URI.file('/workspace'), markers, 'compiler-severity', () => false);
		collector.processLine('/workspace/main.cs(2,3): category fatal   error C7: COMPILER_FATAL');
		assert.deepEqual(markers.getAll().map(marker => [marker.message, marker.severity, marker.code]), [['COMPILER_FATAL', 'warning', 'C7']]);
		assert.equal(collector.hasErrors, false);
	});

	test('compiler coordinates preserve diagnostics while normalizing their editor ranges', () => {
		const cases = [
			{ value: '0|0|0|0', expected: [0, 0, 0, 0] },
			{ value: 'bad|bad|bad|bad', expected: [0, 0, 0, 0] },
			{ value: '3.5|12text||', expected: [2, 11, 2, 11] },
			{ value: '5||9|8', expected: [4, 0, 4, 2147483646] },
			{ value: '5|3|9|', expected: [4, 2, 4, 2] },
			{ value: '3|4|1|0', expected: [2, 3, 2, 3] },
			{ value: '3|8|3|4', expected: [2, 3, 2, 7] },
			{ value: '|2||', expected: undefined },
			{ value: 'Infinity|Infinity||', expected: [0, 0, 0, 0] },
			{ value: '9007199254740992|1||', expected: [0, 0, 0, 0] },
		];
		for (const value of cases) {
			using markers = new MarkerService();
			using collector = new WatchingProblemCollector(parseProblemMatchers([{ pattern: { regexp: '^(.+)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*) (.+)$', file: 1, line: 2, column: 3, endLine: 4, endColumn: 5, message: 6 } }]), URI.file('/workspace'), markers, 'coordinates', () => false);
			collector.processLine(`main.ts|${value.value} RETAINED_DIAGNOSTIC`);
			assert.deepEqual(markers.getAll().map(marker => [marker.range.start.lineIndex, marker.range.start.columnIndex, marker.range.end.lineIndex, marker.range.end.columnIndex]), value.expected ? [value.expected] : [], value.value);
			if (value.expected) assert.equal(markers.getAll()[0].message, 'RETAINED_DIAGNOSTIC');
		}
	});

	test('combined coordinates distinguish whole lines, points, ranges and absent locations', () => {
		for (const [location, expected] of [
			['0,0', [0, 0, 0, 0]], ['4', [3, 0, 3, 2147483646]], ['4,', [3, 0, 3, 0]],
			['4,3,9', [3, 2, 3, 2]], ['4,3,5,6,99', [3, 2, 4, 5]], ['bad,2', [0, 1, 0, 1]],
			['', undefined], ['bad', undefined],
		] as const) {
			using markers = new MarkerService();
			using collector = new WatchingProblemCollector(parseProblemMatchers([{ pattern: { regexp: '^(.+)\\|([^|]*) (.+)$', file: 1, location: 2, message: 3 } }]), URI.file('/workspace'), markers, 'combined', () => false);
			collector.processLine(`main.ts|${location} COMBINED_DIAGNOSTIC`);
			assert.deepEqual(markers.getAll().map(marker => [marker.range.start.lineIndex, marker.range.start.columnIndex, marker.range.end.lineIndex, marker.range.end.columnIndex]), expected ? [expected] : [], location);
		}
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ pattern: { kind: 'file', regexp: '^(.+) (.+) (.+)$', file: 1, location: 2, message: 3 } }]), URI.file('/workspace'), markers, 'file-coordinate', () => false);
		collector.processLine('package.json bad FILE_DIAGNOSTIC');
		assert.deepEqual(markers.getAll().map(marker => marker.range), [{ start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 0 } }]);
	});

	test('named compiler patterns honor the owning inline matcher and Gulp only matches closed documents', () => {
		for (const [pattern, code] of [['$cpp', 'C7'], ['$csc', 'CS7'], ['$vb', 'BC7']]) {
			using markers = new MarkerService();
			using collector = new WatchingProblemCollector(parseProblemMatchers([{ owner: 'named', source: 'compiler', fileLocation: 'relative', pattern }]), URI.file('/workspace'), markers, 'named', () => false);
			collector.processLine(`main.txt(2,3): warning ${code}: NAMED_COMPILER`);
			assert.deepEqual(markers.getAll().map(marker => [marker.message, marker.resource.path, marker.source, marker.code, marker.severity]), [['NAMED_COMPILER', '/workspace/main.txt', 'compiler', code, 'warning']]);
			assert.throws(() => parseProblemMatchers([pattern]), /Unknown problem matcher/);
		}
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers(['$gulp-tsc']), URI.file('/workspace'), markers, 'open', () => true);
		collector.processLine('main.ts(2,3): 101 OMIT_OPEN_FILE');
		assert.deepEqual(markers.getAll(), []);
	});

	test('loop rows restore all header captures before applying optional row captures', () => {
		using markers = new MarkerService();
		const pattern = [{ regexp: '^FILE (.+) (warning)$', file: 1, severity: 2 }, { regexp: '^(\\d+) (.+?)(?: (error) (E\\d+))?$', line: 1, message: 2, severity: 3, code: 4, loop: true }];
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ pattern }]), URI.file('/workspace'), markers, 'headers', () => false);
		collector.accept(new TextEncoder().encode('FILE first.txt warning\n1 FIRST error E1\n2 SECOND\nFILE second.txt warning\n3 THIRD\n'));
		assert.deepEqual(markers.getAll().map(marker => [marker.message, marker.resource.path, marker.severity, marker.code]), [['FIRST', '/workspace/first.txt', 'error', 'E1'], ['SECOND', '/workspace/first.txt', 'warning', undefined], ['THIRD', '/workspace/second.txt', 'warning', undefined]]);
	});

	test('matchers sharing a diagnostic owner retain both formats and reset only their own watching cycle', () => {
		using markers = new MarkerService();
		const pattern = { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 };
		const matchers = [{ owner: 'shared', pattern: { ...pattern, regexp: '^REGULAR (.+):(\\d+):(\\d+) (.+)$' } }, { owner: 'shared', pattern: { ...pattern, regexp: '^WATCH (.+):(\\d+):(\\d+) (.+)$' }, background: { activeOnStart: false, beginsPattern: '^BUILD$', endsPattern: '^READY$' } }];
		using collector = new WatchingProblemCollector(parseProblemMatchers(matchers), URI.file('/workspace'), markers, 'shared', () => false);
		collector.accept(new TextEncoder().encode('REGULAR regular.txt:1:2 RETAINED\nBUILD\nWATCH watching.txt:3:4 REPLACED\nREADY\nBUILD\nREADY\n'));
		assert.deepEqual({ markers: markers.getAll().map(marker => [marker.message, marker.resource.path]), ready: collector.isReady }, { markers: [['RETAINED', '/workspace/regular.txt']], ready: true });
		using lintMarkers = new MarkerService();
		using lint = new WatchingProblemCollector(parseProblemMatchers(['$eslint-compact', '$eslint-stylish']), URI.file('/workspace'), lintMarkers, 'lint', () => false);
		lint.accept(new TextEncoder().encode('/workspace/compact.js: line 1, col 2, Warning - COMPACT (semi)\n/workspace/stylish.js\n  3:4 warning STYLISH  semi\n'));
		assert.deepEqual(lintMarkers.getAll().map(marker => marker.message), ['COMPACT', 'STYLISH']);
	});

	test('search paths preserve scalar and array directories and default only the scalar search mode', () => {
		const pattern = { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 };
		assert.deepEqual(parseProblemMatchers([
			{ pattern, fileLocation: 'search' },
			{ pattern, fileLocation: ['search', { include: ['${workspaceFolder}/src', '/other'], exclude: '/other/generated' }] },
			{ pattern, fileLocation: ['search', {}] },
		]).map(matcher => matcher.searchPaths), [
			{ include: ['${workspaceFolder}'], exclude: [] },
			{ include: ['${workspaceFolder}/src', '/other'], exclude: ['/other/generated'] },
			{ include: [], exclude: [] },
		]);
		for (const paths of [null, [], { include: false }, { exclude: [1] }, { include: '' }, { unknown: '/workspace' }]) {
			assert.throws(() => parseProblemMatchers([{ pattern, fileLocation: ['search', paths] }]));
		}
	});

	test('search diagnostics publish in output order and background readiness waits for lookup', async () => {
		using markers = new MarkerService();
		const first = new DeferredPromise<URI | undefined>();
		const lookedUp: string[] = [];
		const matcher = { fileLocation: 'search', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }, background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } };
		using collector = new WatchingProblemCollector(parseProblemMatchers([matcher]), URI.file('/workspace'), markers, 'search', () => false, async file => {
			lookedUp.push(file);
			return file === 'first.ts' ? first.p : URI.file('/workspace/src/second.ts');
		});
		let ready = 0;
		using listener = collector.onDidBecomeReady(() => ready++);
		collector.accept(new TextEncoder().encode('first.ts:2:3 first\nsecond.ts:4:5 second\nREADY\n'));
		assert.deepEqual({ lookedUp, ready, diagnostics: markers.getAll().length, pending: collector.hasPendingResolutions }, { lookedUp: ['first.ts'], ready: 0, diagnostics: 0, pending: true });
		void first.complete(URI.file('/workspace/src/first.ts'));
		await collector.flush();
		assert.deepEqual(markers.getAll().map(marker => ({ path: marker.resource.path, message: marker.message })), [{ path: '/workspace/src/first.ts', message: 'first' }, { path: '/workspace/src/second.ts', message: 'second' }]);
		assert.deepEqual({ lookedUp, ready, pending: collector.hasPendingResolutions }, { lookedUp: ['first.ts', 'second.ts'], ready: 1, pending: false });
	});

	test('a new watching cycle discards old lookup replies and evaluates applyTo on the found resource', async () => {
		using markers = new MarkerService();
		const old = new DeferredPromise<URI | undefined>();
		const matcher = { fileLocation: 'search', applyTo: 'openDocuments', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }, background: { activeOnStart: false, beginsPattern: '^BUILD$', endsPattern: '^READY$' } };
		using collector = new WatchingProblemCollector(parseProblemMatchers([matcher]), URI.file('/workspace'), markers, 'cycles', resource => resource.path === '/workspace/src/new.ts', async file => file === 'old.ts' ? old.p : URI.file('/workspace/src/new.ts'));
		collector.accept(new TextEncoder().encode('BUILD\nold.ts:1:1 old\nREADY\nBUILD\nnew.ts:2:3 current\nREADY\n'));
		assert.equal(collector.isReady, false);
		void old.complete(URI.file('/workspace/src/old.ts'));
		await collector.flush();
		assert.deepEqual(markers.getAll().map(marker => ({ path: marker.resource.path, message: marker.message })), [{ path: '/workspace/src/new.ts', message: 'current' }]);
		assert.equal(collector.isReady, true);
	});

	test('canceling search aborts its owner and prevents late diagnostics and readiness', async () => {
		using markers = new MarkerService();
		const result = new DeferredPromise<URI | undefined>();
		let signal: AbortSignal | undefined;
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ fileLocation: 'search', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }, background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } }]), URI.file('/workspace'), markers, 'canceled', () => false, async (_file, _matcher, value) => { signal = value; return result.p; });
		collector.accept(new TextEncoder().encode('file.ts:2:3 canceled\nREADY\n'));
		collector.cancelSearch();
		assert.equal(signal?.aborted, true);
		void result.complete(URI.file('/workspace/src/file.ts'));
		await collector.flush();
		assert.deepEqual({ diagnostics: markers.getAll().length, ready: collector.isReady }, { diagnostics: 0, ready: false });
	});

	test('split UTF-8 and ANSI lines publish one diagnostic and flush the final line on exit', () => {
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers(['$tsc']), URI.file('/workspace'), markers, 'compile', () => false);
		const bytes = new TextEncoder().encode('\x1b[31mfile.ts(2,3): error TS123: 中文\x1b[0m');
		for (const byte of bytes) collector.accept(new Uint8Array([byte]));
		assert.equal(markers.getAll().length, 0);
		collector.done();
		assert.deepEqual(markers.getAll().map(marker => ({ path: marker.resource.path, message: marker.message, code: marker.code, range: marker.range })), [{ path: '/workspace/file.ts', message: '中文', code: '123', range: { start: { lineIndex: 1, columnIndex: 2 }, end: { lineIndex: 1, columnIndex: 2 } } }]);
	});

	test('multi-line looping patterns retain the file and replace stale diagnostics on a new compilation', () => {
		using markers = new MarkerService();
		const matcher = { owner: 'lint', pattern: [{ regexp: '^FILE (.+)$', file: 1 }, { regexp: '^  (\\d+):(\\d+) (.+)$', line: 1, column: 2, message: 3, loop: true }], background: { activeOnStart: false, beginsPattern: '^BUILD$', endsPattern: '^READY$' } };
		using collector = new WatchingProblemCollector(parseProblemMatchers([matcher]), URI.parse('vscode-remote://server/project'), markers, 'lint', () => false);
		let ready = 0;
		using listener = collector.onDidBecomeReady(() => ready++);
		collector.accept(new TextEncoder().encode('BUILD\nFILE src/main.ts\n  1:2 first\n  3:4 second\nREADY\n'));
		assert.deepEqual({ paths: markers.getAll().map(marker => marker.resource.toString()), messages: markers.getAll().map(marker => marker.message), ready }, { paths: ['vscode-remote://server/project/src/main.ts', 'vscode-remote://server/project/src/main.ts'], messages: ['first', 'second'], ready: 1 });
		collector.accept(new TextEncoder().encode('BUILD\n'));
		assert.equal(collector.isReady, false);
		collector.accept(new TextEncoder().encode('READY\n'));
		assert.deepEqual({ markers: markers.getAll(), ready }, { markers: [], ready: 2 });
	});

	test('a regexp-only pattern captures the entire message and uses matcher severity', () => {
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ severity: 'warning', pattern: { regexp: '^(.+):(\\d+):(\\d+) (.+)$' } }]), URI.file('/workspace'), markers, 'defaults', () => false);
		collector.processLine('main.ts:3:4 error');
		assert.deepEqual(markers.getAll().map(marker => ({ message: marker.message, severity: marker.severity, range: marker.range })), [{ message: 'main.ts:3:4 error', severity: 'warning', range: { start: { lineIndex: 2, columnIndex: 3 }, end: { lineIndex: 2, columnIndex: 3 } } }]);
	});

	test('array patterns preserve omitted columns and do not infer captures from another entry', () => {
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ pattern: [{ regexp: '^FILE (.+)$', file: 1 }, { regexp: '^(\\d+) (error|warning) (.+)$', line: 1, severity: 2, message: 3, loop: true }] }]), URI.file('/workspace'), markers, 'line-only', () => false);
		collector.processLine('FILE file.ts');
		collector.processLine('5 warning first');
		collector.processLine('6 error second');
		assert.deepEqual(markers.getAll().map(marker => ({ path: marker.resource.path, message: marker.message, severity: marker.severity, range: marker.range })), [
			{ path: '/workspace/file.ts', message: 'first', severity: 'warning', range: { start: { lineIndex: 4, columnIndex: 0 }, end: { lineIndex: 4, columnIndex: 2147483646 } } },
			{ path: '/workspace/file.ts', message: 'second', severity: 'error', range: { start: { lineIndex: 5, columnIndex: 0 }, end: { lineIndex: 5, columnIndex: 2147483646 } } },
		]);
	});

	test('file-only kind belongs to the whole multiline match and has no inferred severity', () => {
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers([{ severity: 'warning', pattern: [{ kind: 'file', regexp: '^FILE (.+)$', file: 1 }, { regexp: '^MESSAGE (.+)$', message: 1 }] }]), URI.file('/workspace'), markers, 'file-only', () => false);
		collector.processLine('FILE package.json');
		collector.processLine('MESSAGE error');
		assert.deepEqual(markers.getAll().map(marker => ({ message: marker.message, severity: marker.severity, range: marker.range })), [{ message: 'error', severity: 'warning', range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 0 } } }]);
	});

	test('array patterns require their explicit aggregate captures before a process can start', () => {
		for (const pattern of [
			[{ regexp: '(.+)', file: 1 }],
			[{ regexp: '(.+)', message: 1, line: 1 }],
			[{ regexp: '(.+)', file: 1, message: 1 }],
			[{ regexp: '(.+)', file: 1 }, { regexp: '(.+)', message: 1, kind: 'file' }],
		]) assert.throws(() => parseProblemMatchers([{ pattern }]));
	});

	test('contributed named patterns and inherited matchers drive diagnostics and background readiness', () => {
		const contributions = {
			patterns: [{ name: 'ash-test-pattern', regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }],
			matchers: [
				{ name: 'ash-test-base', owner: 'contributed', pattern: '$ash-test-pattern' },
				{ name: 'ash-test-derived', base: '$ash-test-base', severity: 'warning', background: { activeOnStart: false, beginsPattern: '^BUILD$', endsPattern: '^READY$' } },
			],
		};
		using registration = registerProblemMatcherContributions(contributions);
		using markers = new MarkerService();
		using collector = new WatchingProblemCollector(parseProblemMatchers(['$ash-test-derived']), URI.file('/workspace'), markers, 'contributed', () => false);
		collector.accept(new TextEncoder().encode('BUILD\nmain.ts:2:3 extension issue\nREADY\n'));
		assert.equal(collector.isReady, true);
		assert.deepEqual(markers.getAll().map(marker => ({ message: marker.message, resource: marker.resource.path, severity: marker.severity })), [{ message: 'extension issue', resource: '/workspace/main.ts', severity: 'warning' }]);
		contributions.patterns[0].regexp = '^changed$';
		assert.equal(parseProblemMatchers(['$ash-test-base'])[0].pattern[0].regexp.source, '^(.+):(\\d+):(\\d+) (.+)$');
		assert.throws(() => registration.replace({ patterns: [], matchers: [{ name: 'ash-test-broken', base: '$absent' }] }), /Unknown problem matcher/);
		assert.equal(parseProblemMatchers(['$ash-test-base'])[0].owner, 'contributed');
		registration.dispose();
		assert.throws(() => parseProblemMatchers(['$ash-test-base']), /Unknown problem matcher/);
		assert.throws(() => registration.replace(contributions), /disposed/);
	});

	test('contribution replacement rejects cycles, duplicate owners and malformed expressions atomically', () => {
		using registration = registerProblemMatcherContributions({ patterns: [], matchers: [{ name: 'ash-test-valid', base: '$tsc', owner: 'contributed' }] });
		assert.throws(() => registerProblemMatcherContributions({ patterns: [], matchers: [{ name: 'ash-test-valid', base: '$gcc' }] }), /already registered/);
		for (const invalid of [
			{ patterns: [], matchers: [{ name: 'cycle-a', base: '$cycle-b' }, { name: 'cycle-b', base: '$cycle-a' }] },
			{ patterns: [{ name: 'bad', regexp: '[' }], matchers: [] },
			{ patterns: [{ name: 'bad', patterns: [] }], matchers: [] },
		]) assert.throws(() => registration.replace(invalid));
		assert.equal(parseProblemMatchers(['$ash-test-valid'])[0].owner, 'contributed');
	});

	test('invalid contributed matcher references report the selected locale before publication', () => {
		using localization = toDisposable(resetNlsResolver);
		initializeTestLocalization('zh-CN');
		assert.throws(() => registerProblemMatcherContributions({ patterns: [], matchers: [{ name: 'localized-cycle', base: '$localized-cycle' }] }), { message: '问题匹配器基础引用“$localized-cycle”存在循环' });
		assert.throws(() => parseProblemMatchers(['$localized-cycle']), /Unknown problem matcher/);
		assert.throws(() => parseProblemMatchers([{ pattern: '$missing-pattern' }]), { message: '未知的问题模式“$missing-pattern”' });
	});
});
