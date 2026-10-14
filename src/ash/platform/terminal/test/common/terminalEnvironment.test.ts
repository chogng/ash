import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { suite, test } from 'mocha';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { escapeNonWindowsPath, sanitizeCwd } from '../../common/terminalEnvironment.js';
import { GeneralShellType, PosixShellType } from '../../common/terminal.js';

suite('Terminal launch environment operations', () => {
	test('literal POSIX arguments retain quotes, Unicode and shell expansion characters', function () {
		if (process.platform === 'win32') this.skip();
		const value = '中文🙂 $HOME $(printf injected) a\'";tail\\';
		const output = execFileSync('/bin/sh', ['-c', `printf %s ${escapeNonWindowsPath(value)}`], { encoding: 'utf8' });
		assert.equal(output, value);
	});

	test('PowerShell and Fish use their own single-quote rules', () => {
		assert.equal(escapeNonWindowsPath("one'two", GeneralShellType.PowerShell), "'one''two'");
		assert.equal(escapeNonWindowsPath("one\\two'three", PosixShellType.Fish), "'one\\\\two\\'three'");
	});

	test('cwd normalization follows the execution host and leaves ordinary quoted filename characters intact', () => {
		assert.equal(sanitizeCwd('"c:\\workspace"', OperatingSystem.Windows), 'C:\\workspace');
		assert.equal(sanitizeCwd("'/workspace/中文'", OperatingSystem.Linux), '/workspace/中文');
		assert.equal(sanitizeCwd('c:/workspace', OperatingSystem.Linux), 'c:/workspace');
		assert.equal(sanitizeCwd('"/workspace\'', OperatingSystem.Linux), '"/workspace\'');
	});
});
