import assert from "node:assert/strict";
import { test } from "mocha";
import { cargoWorkspaceTasks, parsePackageTasks, parseWorkspaceTasks } from "../../common/workspaceTasks.js";

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
	assert.deepEqual(tasks[1].unsupportedFeatures, ["type:process"]);
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
	assert.deepEqual(tasks[1].unsupportedFeatures, ['type:process', 'options.cwd', 'options.env', 'dependsOn', 'problemMatcher', 'isBackground']);
	assert.deepEqual(tasks[2].unsupportedFeatures, ['type:npm']);
	assert.deepEqual(tasks[2].configuration?.task, { label: 'Provider', type: 'npm', script: 'build', custom: { version: 2 } });
});

test('workspace tasks do not discard inherited execution settings or unimplemented variables and quoting', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', options: { cwd: '/other' }, linux: { command: 'linux-build' }, tasks: [
			{ label: 'Inherited', command: 'build', args: ['${input:target}', '$(touch should-not-exist)'] },
		]
	}));
	assert.deepEqual(tasks[0].unsupportedFeatures, ['options.cwd', 'linux', 'args[0]', 'args[1]']);
});


test('unresolved provider labels and structured shell quoting remain discoverable without changing their semantics', () => {
	const tasks = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', tasks: [
			{ type: 'npm', script: 'build', group: 'build' },
			{ label: 'Quoted', type: 'shell', command: { value: 'build app', quoting: 'strong' }, args: [{ value: 'target app', quoting: 'weak' }] },
			{ label: 'Defaults', command: 'build', options: { env: {} }, presentation: { extensionMetadata: true }, runOptions: { runOn: 'default', reevaluateOnRerun: true } },
		]
	}));
	assert.deepEqual(tasks.map(task => [task.label, task.unsupportedFeatures]), [['npm', ['type:npm']], ['Quoted', ['command', 'args[0]']], ['Defaults', []]]);
	assert.equal(tasks[0].configuration?.version, '2.0.0');
	assert.throws(() => parseWorkspaceTasks('{"version":"0.1.0","tasks":[]}'), /version must be '2.0.0'/);
});


test('empty task environments cannot erase unsupported inherited environment semantics', () => {
	const source = { version: '2.0.0', options: { env: { MODE: 'test' } }, tasks: [{ label: 'Inherited env', command: 'build', options: { env: {} } }] };
	const task = parseWorkspaceTasks(JSON.stringify(source))[0];
	assert.deepEqual(task.unsupportedFeatures, ['options.env']);
	assert.deepEqual(task.configuration?.task.options, { env: {} });
	assert.deepEqual(parseWorkspaceTasks(JSON.stringify({ ...source, options: { env: {} } }))[0].unsupportedFeatures, []);
});


test('empty task overrides do not discard inherited platform, presentation, or run policies', () => {
	const task = parseWorkspaceTasks(JSON.stringify({
		version: '2.0.0', linux: { command: 'linux-build' }, presentation: { reveal: 'never' }, runOptions: { runOn: 'folderOpen' }, tasks: [
			{ label: 'Inherited settings', command: 'build', linux: {}, presentation: {}, runOptions: {} },
		]
	}))[0];
	assert.deepEqual(task.unsupportedFeatures, ['runOptions.runOn', 'linux', 'presentation']);
});


test('shell arguments cannot supply a missing or empty command', () => {
	for (const command of [undefined, '', '   ']) {
		assert.throws(() => parseWorkspaceTasks(JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Missing command', type: 'shell', command, args: ['touch', 'should-not-exist'] }] })), /command must contain/);
	}
});
