import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkGitImportCase, checkImportCase } from './importCase.ts';

test('checks and fixes static import paths using canonical directories and TypeScript source names', t => {
	const root = mkdtempSync(join(tmpdir(), 'ash-import-case-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, 'sidebar'));
	writeFileSync(join(root, 'sidebar', 'sidebarPart.ts'), 'export class SidebarPart {}');
	const original = '// import "./SIDEBAR/SidebarPart.js";\nimport { SidebarPart } from "./SIDEBAR/SidebarPart.js";\nexport { SidebarPart as Part } from "./sidebar/SidebarPart.js";\nimport ts from "typescript";\n';
	writeFileSync(join(root, 'entry.ts'), original);
	const inventory = ['entry.ts', 'sidebar/sidebarPart.ts'];
	assert.equal(checkImportCase(root, ['entry.ts'], inventory).length, 2);
	assert.equal(readFileSync(join(root, 'entry.ts'), 'utf8'), original);
	assert.ok(checkImportCase(root, ['entry.ts'], inventory, true).every(issue => issue.fixed));
	assert.equal(readFileSync(join(root, 'entry.ts'), 'utf8'), original.replace('from "./SIDEBAR/SidebarPart.js"', 'from "./sidebar/sidebarPart.js"').replace('from "./sidebar/SidebarPart.js"', 'from "./sidebar/sidebarPart.js"'));
	assert.deepEqual(checkImportCase(root, ['entry.ts'], inventory), []);
});

test('resolves extensionless directory imports and reports case collisions without choosing a file', t => {
	const root = mkdtempSync(join(tmpdir(), 'ash-import-case-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const original = 'import "./Directory";\nimport "./TARGET.js";\n';
	writeFileSync(join(root, 'entry.ts'), original);
	const issues = checkImportCase(root, ['entry.ts'], ['entry.ts', 'directory/index.ts', 'target.ts', 'Target.ts'], true);
	assert.equal(issues.length, 2);
	assert.equal(issues[0]!.fixed, true);
	assert.equal(issues[1]!.fixed, false);
	assert.match(issues[1]!.message, /Ambiguous import/);
	assert.equal(readFileSync(join(root, 'entry.ts'), 'utf8'), original.replace('./Directory', './directory'));
});

test('checks dynamic imports, require calls, and resource spelling without rewriting unresolved imports', t => {
	const root = mkdtempSync(join(tmpdir(), 'ash-import-case-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, 'entry.ts'), 'import("./MODULE.mjs"); require("./MODULE.cjs"); import "./STYLE.css"; import "./not-installed.js";');
	const issues = checkImportCase(root, ['entry.ts'], ['entry.ts', 'module.mts', 'module.cts', 'style.css'], true);
	assert.equal(issues.length, 3);
	assert.ok(issues.every(issue => issue.fixed));
	assert.equal(readFileSync(join(root, 'entry.ts'), 'utf8'), 'import("./module.mjs"); require("./module.cjs"); import "./style.css"; import "./not-installed.js";');
});

test('staged and committed checks reject broken snapshots even after the working tree is repaired', t => {
	const root = mkdtempSync(join(tmpdir(), 'ash-import-index-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
	git('init');
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'entry.ts'), 'import "./SidebarPart.js";');
	writeFileSync(join(root, 'src', 'sidebarPart.ts'), 'export {};');
	git('add', 'src/entry.ts', 'src/sidebarPart.ts');
	writeFileSync(join(root, 'src', 'entry.ts'), 'import "./sidebarPart.js";');
	assert.equal(checkGitImportCase(root).length, 1);
	git('-c', 'user.name=Import Test', '-c', 'user.email=import-test@example.invalid', 'commit', '-m', 'Broken import fixture');
	assert.equal(checkGitImportCase(root, 'HEAD').length, 1);
	git('add', 'src/entry.ts');
	assert.deepEqual(checkGitImportCase(root), []);
	assert.equal(checkGitImportCase(root, 'HEAD').length, 1);
});
