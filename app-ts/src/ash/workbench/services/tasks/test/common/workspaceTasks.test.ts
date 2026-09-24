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
	assert.throws(() => parseWorkspaceTasks('{"version":"2.0.0","tasks":[{"label":"unsafe","type":"npm","command":"ignored"}]}'), /type must be/);
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
