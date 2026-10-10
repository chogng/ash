import assert from "node:assert/strict";
import { test } from "mocha";
import { cargoWorkspaceTasks, parsePackageTasks, parseWorkspaceTasks } from "../../common/workspaceTasks.js";
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';

test("workspace tasks parse supported VS Code shell tasks and preserve explicit execution", () => {
	const tasks = parseWorkspaceTasks(`{
    // Compatible VS Code task configuration.
    "version": "2.0.0",
    "tasks": [
      { "label": "Build app", "type": "shell", "command": "cargo", "args": ["build", "--package", "ash code"], "group": "build", },
      { "label": "Check", "type": "process", "command": "cargo check" }
    ],
  }`);
	assert.deepEqual(tasks.map(task => ({ label: task.label, command: task.command, group: task.group, source: task.source })), [
		{ label: "Build app", command: 'cargo build --package "ash code"', group: "build", source: "vscode" },
		{ label: "Check", command: "cargo check", group: "other", source: "vscode" },
	]);
	assert.deepEqual(tasks[1].unsupportedFeatures, []);
	assert.deepEqual(tasks[1].execution, { type: 'process', program: 'cargo check', args: [] });
});

test("package and Cargo task discovery stays deterministic", () => {
	const packageTasks = parsePackageTasks('{"scripts":{"test":"node --test","build":"vite build","dev":"vite","bad name":"ignored"}}', "pnpm");
	assert.deepEqual(packageTasks.map(task => [task.label, task.command, task.group]), [
		["test", "pnpm run test", "test"],
		["build", "pnpm run build", "build"],
		["dev", "pnpm run dev", "run"],
	]);
	assert.deepEqual(cargoWorkspaceTasks().map(task => task.command), ["cargo check", "cargo build", "cargo test", "cargo run"]);
});


test('workspace tasks preserve metadata and identify unsupported execution without removing siblings', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', customVersion: 3, tasks: [
			{ label: 'Safe', type: 'shell', command: 'build', detail: 'Build metadata', custom: { owner: 'extension' }, options: { custom: true }, problemMatcher: [], dependsOn: [], isBackground: false },
			{ label: 'Configured', type: 'process', command: 'build', options: { cwd: '${workspaceFolder}/app', env: { MODE: 'test' } }, dependsOn: ['Safe'], problemMatcher: '$tsc', isBackground: true },
			{ label: 'Provider', type: 'npm', script: 'build', custom: { version: 2 } },
		]
	}));
	assert.equal(tasks.length, 3);
	assert.deepEqual(tasks[0].unsupportedFeatures, []);
	assert.deepEqual(tasks[0].configuration?.task.custom, { owner: 'extension' });
	assert.equal(tasks[0].configuration?.defaults.customVersion, 3);
	assert.equal(Object.isFrozen(tasks[0].configuration?.task.custom), true);
	assert.deepEqual(tasks[1].unsupportedFeatures, []);
	assert.deepEqual(tasks[2].unsupportedFeatures, ['type:npm']);
	assert.deepEqual(tasks[2].configuration?.task, { label: 'Provider', type: 'npm', script: 'build', custom: { version: 2 } });
});

test('workspace tasks preserve shell arguments for dispatch-time quoting and retain unsupported platform settings', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', options: { cwd: '/other' }, linux: { command: 'linux-build' }, tasks: [
			{ label: 'Inherited', command: 'build', args: ['${input:target}', '$(touch should-not-exist)'] },
		]
	}));
	assert.deepEqual(tasks[0].unsupportedFeatures, ['linux']);
	assert.deepEqual(tasks[0].execution, { type: 'shell', command: 'build', args: ['${input:target}', '$(touch should-not-exist)'] });
});

for (const [os, key] of [[OperatingSystem.Windows, 'windows'], [OperatingSystem.Macintosh, 'osx'], [OperatingSystem.Linux, 'linux']] as const) {
	test(`workspace task ${key} overrides apply at each scope and merge child environments`, () => {
		const document = {
			version: '2.0.0', type: 'process', command: 'base', args: ['base'], options: { cwd: '/base', env: { INHERITED: 'base', DEFAULT: 'base', TASK: 'base', REMOVED: 'base' } },
			[key]: { command: 'default-platform', args: ['default-platform'], options: { cwd: '/default-platform', env: { DEFAULT: key, TASK: 'default-platform' } } },
			tasks: [
				{ label: 'Inherited' },
				{ label: 'Task base', command: 'task-base', args: ['task-base'], options: { env: { TASK: 'task-base' } } },
				{ label: 'Task platform', command: 'task-base', options: { env: { TASK: 'task-base' } }, [key]: { command: 'task-platform', args: ['', 'literal $HOME'], options: { cwd: '${workspaceFolder}/platform', env: { TASK: key, REMOVED: null } } } },
			],
		};
		const tasks = parseWorkspaceTasks(JSON.stringify(document), os);
		assert.deepEqual(tasks.map(task => task.execution), [
			{ type: 'process', program: 'default-platform', args: ['default-platform'] },
			{ type: 'process', program: 'task-base', args: ['task-base'] },
			{ type: 'process', program: 'task-platform', args: ['', 'literal $HOME'] },
		]);
		assert.deepEqual(tasks[2].environment, { INHERITED: 'base', DEFAULT: key, TASK: key, REMOVED: null });
		assert.equal(tasks[2].cwd, '${workspaceFolder}/platform');
		assert.deepEqual(tasks.map(task => task.unsupportedFeatures), [[], [], []]);
		assert.deepEqual(tasks[2].configuration?.task, document.tasks[2], 'original JSON remains unchanged');
	});
}

test('workspace tasks ignore inactive platform execution fields and reject invalid block shapes', () => {
	const document = { version: '2.0.0', tasks: [{ label: 'Portable', type: 'process', command: 'portable', windows: { command: 42, options: { env: { INVALID: false } } }, osx: { command: 'mac' } }] };
	assert.equal(parseWorkspaceTasks(JSON.stringify(document), OperatingSystem.Linux)[0].command, 'portable');
	assert.throws(() => parseWorkspaceTasks(JSON.stringify(document), OperatingSystem.Windows), /Task environment/);
	assert.throws(() => parseWorkspaceTasks(JSON.stringify({ ...document, linux: 42 }), OperatingSystem.Linux), /linux must be an object/);
});


test('unresolved provider labels remain discoverable and structured shell quoting retains its explicit style', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', tasks: [
			{ type: 'npm', script: 'build', group: 'build' },
			{ label: 'Quoted', type: 'shell', command: { value: 'build app', quoting: 'strong' }, args: [{ value: 'target app', quoting: 'weak' }] },
			{ label: 'Defaults', command: 'build', options: { env: {} }, presentation: { extensionMetadata: true }, runOptions: { runOn: 'default', reevaluateOnRerun: true } },
		]
	}));
	assert.deepEqual(tasks.map(task => [task.label, task.unsupportedFeatures]), [['npm', ['type:npm']], ['Quoted', []], ['Defaults', []]]);
	assert.deepEqual(tasks[1].execution, { type: 'shell', command: { value: 'build app', quoting: 2 }, args: [{ value: 'target app', quoting: 3 }] });
	assert.equal(tasks[0].configuration?.version, '2.0.0');
	assert.throws(() => parseWorkspaceTasks('{"version":"0.1.0","tasks":[]}'), /version must be '2.0.0'/);
});


test('empty task environments retain inherited variables', () => {
	const source = { version: '2.0.0', options: { env: { MODE: 'test' } }, tasks: [{ label: 'Inherited env', command: 'build', options: { env: {} } }] };
	const task = parseWorkspaceTasks(JSON.stringify(source))[0];
	assert.deepEqual({ unsupported: task.unsupportedFeatures, environment: task.environment }, { unsupported: [], environment: { MODE: 'test' } });
	assert.deepEqual(task.configuration?.task.options, { env: {} });
	assert.deepEqual(parseWorkspaceTasks(JSON.stringify({ ...source, options: { env: {} } }))[0].unsupportedFeatures, []);
});

test('task environment removals override defaults while preserving literal values', () => {
	const value = parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', options: { env: { MODE: 'default', REMOVED: 'default' } }, tasks: [{ label: 'Environment', type: 'process', command: 'build', options: { env: { MODE: '$HOME literal', REMOVED: null } } }] }))[0];
	assert.deepEqual(value.environment, { MODE: '$HOME literal', REMOVED: null });
	for (const env of [{ VALUE: false }, { VALUE: 1 }, { 'BAD=KEY': null }, { VALUE: '\0' }]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', options: { env } }] })), /Task environment/);
	}
});


test('empty task overrides do not discard inherited platform, presentation, or run policies', () => {
	const task = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', linux: { command: 'linux-build' }, presentation: { reveal: 'never' }, runOptions: { runOn: 'folderOpen' }, tasks: [
			{ label: 'Inherited settings', command: 'build', linux: {}, presentation: {}, runOptions: {} },
		]
	}))[0];
	assert.deepEqual(task.unsupportedFeatures, ['runOptions.runOn', 'linux']);
	assert.deepEqual(task.presentation, { reveal: 'never' });
});


test('shell arguments cannot supply a missing or empty command', () => {
	for (const command of [undefined, '', '   ']) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Missing command', type: 'shell', command, args: ['touch', 'should-not-exist'] }] })), /command must contain/);
	}
});

test('workspace tasks admit environment, workspace, command and configured input variables', () => {
	const commands = ['${workspaceFolder:Server}/build ${workspaceFolderBasename:Client} ${command:target}', '${env:HOME}', '${input:target}', '${workspaceFolder:}'];
	const tasks = parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: commands.map((command, index) => ({ label: `Task ${index}`, command })) }));
	assert.deepEqual(tasks.map(task => ({ command: task.command, unsupported: task.unsupportedFeatures })), [
		{ command: commands[0], unsupported: [] },
		{ command: commands[1], unsupported: [] },
		{ command: commands[2], unsupported: [] },
		{ command: commands[3], unsupported: ['command'] },
	]);
});


test('legacy workspace variables share the current execution resolver capability', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', tasks: [{ label: 'Legacy configuration', type: 'process', command: '${workspaceRoot:Server}/build', args: ['${workspaceRootFolderName}', '${workspaceRootFolderName:Client}'] }],
	}));
	assert.deepEqual(tasks[0]?.unsupportedFeatures, []);
});


test('standard task groups preserve the optional default flag', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Clean', type: 'process', command: 'clean', group: 'clean' },
			{ label: 'Rebuild', type: 'process', command: 'rebuild', group: { kind: 'rebuild', isDefault: false } },
			{ label: 'Build', type: 'process', command: 'build', group: { kind: 'build', isDefault: true } },
			{ label: 'TypeScript', type: 'process', command: 'build', group: { kind: 'build', isDefault: '**/*.{ts,tsx}' } },
		]
	}));
	assert.deepEqual(tasks.map(task => [task.group, task.groupIsDefault]), [['clean', undefined], ['rebuild', false], ['build', true], ['build', '**/*.{ts,tsx}']]);
	assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Bad group', command: 'build', group: { kind: 'build', isDefault: 1 } }] })), /group.isDefault/);
});


test('task reuse notices inherit, override and reject malformed boolean values', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', presentation: { showReuseMessage: false }, tasks: [
			{ label: 'Inherited', command: 'build' },
			{ label: 'Override', command: 'build', presentation: { showReuseMessage: true } },
		]
	}));
	assert.deepEqual(tasks.map(task => ({ presentation: task.presentation, unsupported: task.unsupportedFeatures })), [
		{ presentation: { showReuseMessage: false }, unsupported: [] },
		{ presentation: { showReuseMessage: true }, unsupported: [] },
	]);
	for (const showReuseMessage of [null, 'false', 0, {}]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', presentation: { showReuseMessage } }] })), /Invalid task presentation/);
	}
});

test('task rerun policy inherits boolean values and rejects malformed values', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', runOptions: { reevaluateOnRerun: false }, tasks: [
			{ label: 'Inherited', command: 'build', runOptions: {} },
			{ label: 'Reevaluate', command: 'build', runOptions: { reevaluateOnRerun: true } },
		]
	}));
	assert.deepEqual(tasks.map(task => ({ policy: task.runOptions, unsupported: task.unsupportedFeatures })), [
		{ policy: { reevaluateOnRerun: false }, unsupported: [] },
		{ policy: { reevaluateOnRerun: true }, unsupported: [] },
	]);
	for (const reevaluateOnRerun of [null, 'false', 0]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', runOptions: { reevaluateOnRerun } }] })), /reevaluateOnRerun must be a boolean/);
	}
});


test('workspace task instance limits inherit and validate before execution', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', runOptions: { instanceLimit: 2 }, tasks: [
			{ label: 'Inherited', command: 'build', runOptions: {} },
			{ label: 'Override', command: 'build', runOptions: { instanceLimit: 3 } },
		]
	}));
	assert.deepEqual(tasks.map(task => ({ policy: task.runOptions, unsupported: task.unsupportedFeatures })), [
		{ policy: { instanceLimit: 2 }, unsupported: [] },
		{ policy: { instanceLimit: 3 }, unsupported: [] },
	]);
	for (const instanceLimit of [null, '2', 0, -1, 1.5]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', runOptions: { instanceLimit } }] })), /instanceLimit must be a positive integer/);
	}
});

test('task terminal panel and clear policies inherit, override and validate in the selected language', () => {
	const parsed = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', presentation: { panel: 'shared', clear: true }, tasks: [
			{ label: 'Inherited', command: 'first', presentation: {} },
			{ label: 'Dedicated', command: 'second', presentation: { panel: 'dedicated', clear: false } },
			{ label: 'New', command: 'third', presentation: { panel: 'new' } },
		]
	}));
	assert.deepEqual(parsed.map(task => [task.presentation, task.unsupportedFeatures]), [[{ panel: 'shared', clear: true }, []], [{ panel: 'dedicated', clear: false }, []], [{ panel: 'new', clear: true }, []]]);
	for (const presentation of [{ panel: 'unknown' }, { clear: 'true' }]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Bad presentation', command: 'build', presentation }] })), /Invalid task presentation/);
	}
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Bad presentation', command: 'build', presentation: { panel: 'unknown' } }] })), { message: '任务呈现选项无效。' });
});

test('task command echo inherits and overrides independently of terminal reuse', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', presentation: { echo: false, panel: 'dedicated' }, tasks: [
			{ label: 'Inherited', command: 'first', presentation: {} },
			{ label: 'Echo', command: 'second', presentation: { echo: true } },
		],
	}));
	assert.deepEqual(tasks.map(task => [task.presentation, task.unsupportedFeatures]), [[{ echo: false, panel: 'dedicated' }, []], [{ echo: true, panel: 'dedicated' }, []]]);
	for (const echo of [null, 'true', 1, {}]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', presentation: { echo } }] })), /Invalid task presentation/);
	}
});

test('task instance policies inherit, override and reject unknown policies', () => {
	const policies = ['terminateNewest', 'terminateOldest', 'prompt', 'warn', 'silent'];
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', runOptions: { instancePolicy: 'terminateOldest' }, tasks: [
			{ label: 'Inherited', command: 'build', runOptions: {} },
			...policies.map(instancePolicy => ({ label: instancePolicy, command: 'build', runOptions: { instancePolicy } })),
		]
	}));
	assert.deepEqual(tasks.map(task => ({ policy: task.runOptions?.instancePolicy, unsupported: task.unsupportedFeatures })), ['terminateOldest', ...policies].map(policy => ({ policy, unsupported: [] })));
	for (const instancePolicy of [null, 'terminate', 0, true, {}]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', runOptions: { instancePolicy } }] })), /instancePolicy must be/);
	}
});

test('task reveal, focus and close inherit independently and validate their value types', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', presentation: { reveal: 'always', focus: true, close: false }, tasks: [
			{ label: 'Silent', command: 'build', presentation: { reveal: 'silent', focus: false } },
			{ label: 'Never', command: 'build', presentation: { reveal: 'never', close: true } },
		]
	}));
	assert.deepEqual(tasks.map(task => [task.presentation, task.unsupportedFeatures]), [[{ reveal: 'silent', focus: false, close: false }, []], [{ reveal: 'never', focus: true, close: true }, []]]);
	for (const presentation of [{ reveal: 1 }, { reveal: 'sometimes' }, { focus: 'true' }, { close: 1 }]) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', presentation }] })), /Invalid task presentation/);
	}
});


test('configured group provenance follows platform precedence while retaining original task JSON', () => {
	for (const os of [OperatingSystem.Windows, OperatingSystem.Macintosh, OperatingSystem.Linux]) {
		const key = os === OperatingSystem.Windows ? 'windows' : os === OperatingSystem.Macintosh ? 'osx' : 'linux';
		const configured = { label: 'Platform group', type: 'builder', [key]: { group: 'build' } };
		const document = { version: '2.0.0', [key]: { group: 'test' }, tasks: [configured] };
		const [parsed] = parseWorkspaceTasks(JSON.stringify(document), os);
		assert.deepEqual({ group: parsed!.group, default: parsed!.groupIsDefault, configured: parsed!.configuration!.groupIsConfigured, original: parsed!.configuration!.task }, { group: 'build', default: undefined, configured: true, original: configured });
		const [unset] = parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Unconfigured', type: 'builder', [key]: { presentation: { focus: false } } }] }), os);
		assert.equal(unset!.configuration!.groupIsConfigured, false);
	}
});

test('task problem reveal policies inherit independently of terminal reveal and reject invalid values', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', presentation: { reveal: 'never', revealProblems: 'onProblem' }, tasks: [
			{ label: 'Inherited', command: 'build' },
			{ label: 'Always', command: 'build', presentation: { reveal: 'always', revealProblems: 'always' } },
			{ label: 'Never', command: 'build', presentation: { revealProblems: 'never' } },
		]
	}));
	assert.deepEqual(tasks.map(task => ({ presentation: task.presentation, unsupported: task.unsupportedFeatures })), [
		{ presentation: { reveal: 'never', revealProblems: 'onProblem' }, unsupported: [] },
		{ presentation: { reveal: 'always', revealProblems: 'always' }, unsupported: [] },
		{ presentation: { reveal: 'never', revealProblems: 'never' }, unsupported: [] },
	]);
	for (const revealProblems of [1, null, 'silent']) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid', command: 'build', presentation: { revealProblems } }] })), /Invalid task presentation/);
	}
});
