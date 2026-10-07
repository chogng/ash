import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { pythonCommand, type PythonHost } from './python.ts';

const arguments_ = ['-B', 'build/runtime/prepare.py'];

test('python command honors the configured interpreter', () => {
	assert.deepEqual(pythonCommand(arguments_, host('linux', { PYTHON: '/tools/python' }, () => true)), {
		command: '/tools/python',
		args: arguments_,
	});
});

test('Unix Node tools reuse the initialized repository Python before host interpreters', () => {
	const repositoryPython = resolve(import.meta.dirname, '../scripts/.venv/bin/python');
	for (const platform of ['darwin', 'linux'] as const) {
		assert.deepEqual(pythonCommand(arguments_, host(platform, {}, path => path === repositoryPython || path.startsWith('/opt/homebrew/'))), {
			command: repositoryPython,
			args: arguments_,
		});
	}
});

test('python command selects Homebrew Python on Apple Silicon', () => {
	const homebrewPython = '/opt/homebrew/opt/python@3.12/libexec/bin/python3';
	assert.deepEqual(pythonCommand(arguments_, host('darwin', {}, path => path === homebrewPython)), {
		command: homebrewPython,
		args: arguments_,
	});
});

test('python command uses the platform command when no interpreter is configured', () => {
	assert.deepEqual(pythonCommand(arguments_, host('linux')), { command: 'python3', args: arguments_ });
});

test('Windows Node tools use the Python environment installed for the repository', () => {
	assert.deepEqual(pythonCommand(arguments_, host('win32')), { command: resolve(import.meta.dirname, '../scripts/.venv/Scripts/python.exe'), args: arguments_ });
});

function host(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv = {}, fileExists: (path: string) => boolean = () => false): PythonHost {
	return { platform, environment, fileExists };
}
