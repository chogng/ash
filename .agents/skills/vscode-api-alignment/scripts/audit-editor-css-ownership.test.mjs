import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
	auditEditorCssOwnership,
	classifyCssPair,
	findAddedUpstreamBrandLines,
	findChangedPaths,
	findUpstreamBrandLines,
	normalizeCssBranding,
} from './audit-editor-css-ownership.mjs';

test('normalizes the standard license header and Ash CSS branding for upstream-equivalence reporting', () => {
	assert.equal(
		normalizeCssBranding('.stanza-editor { color: var(--ash-editor-foreground); }'),
		'.monaco-editor { color: var(--vscode-editor-foreground); }',
	);
	assert.equal(
		classifyCssPair('.stanza-editor { color: red; }', '.monaco-editor { color: red; }'),
		'upstream-equivalent after branding',
	);
	assert.equal(
		classifyCssPair(
			'.stanza-editor { color: red; }',
			'/*---------------------------------------------------------------------------------------------\n *  Copyright (c) Microsoft Corporation. All rights reserved.\n *  Licensed under the MIT License. See License.txt in the project root for license information.\n *--------------------------------------------------------------------------------------------*/\n\n.monaco-editor { color: red; }',
		),
		'upstream-equivalent after branding',
	);
	assert.equal(classifyCssPair('.local { color: red; }', '.upstream { color: red; }'), 'independent');
});

test('finds upstream product class and theme variable references with locations', () => {
	assert.deepEqual(findUpstreamBrandLines([
		'.monaco-editor .line {',
		'  color: var(--vscode-editor-foreground);',
		'}',
	].join('\n'), 'browser/editor.css'), [
		{ path: 'browser/editor.css', line: 1, value: 'monaco-editor' },
		{ path: 'browser/editor.css', line: 2, value: '--vscode-editor-foreground' },
	]);
});

test('checks added diff lines without treating removed upstream branding as new debt', () => {
	const diff = [
		'diff --git a/app-ts/src/ash/editor/editor.css b/app-ts/src/ash/editor/editor.css',
		'--- a/app-ts/src/ash/editor/editor.css',
		'+++ b/app-ts/src/ash/editor/editor.css',
		'@@ -4,2 +4,2 @@',
		'-.monaco-editor { color: var(--vscode-editor-foreground); }',
		'+.stanza-editor { color: var(--ash-editor-foreground); }',
		'@@ -10,0 +11 @@',
		'+.monaco-cursor { color: var(--vscode-editorCursor-foreground); }',
	].join('\n');
	assert.deepEqual(findAddedUpstreamBrandLines(diff), [
		{ path: 'app-ts/src/ash/editor/editor.css', line: 11, value: 'monaco-cursor' },
		{ path: 'app-ts/src/ash/editor/editor.css', line: 11, value: '--vscode-editorCursor-foreground' },
	]);
	assert.deepEqual(findChangedPaths(diff), ['app-ts/src/ash/editor/editor.css']);
});

test('ignores upstream branding mentioned only in Editor documentation', () => {
	const diff = [
		'diff --git a/app-ts/src/ash/editor/api-alignment-status.md b/app-ts/src/ash/editor/api-alignment-status.md',
		'--- a/app-ts/src/ash/editor/api-alignment-status.md',
		'+++ b/app-ts/src/ash/editor/api-alignment-status.md',
		'@@ -1,0 +2 @@',
		'+Do not add monaco-editor or --vscode-editor-foreground to Ash source.',
	].join('\n');

	assert.deepEqual(findAddedUpstreamBrandLines(diff), []);
});

test('blocks a changed CSS file whose only substantive difference is Ash branding', () => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), 'ash-css-ownership-'));
	try {
		const localRoot = join(fixtureRoot, 'app-ts/src/ash/editor');
		const upstreamRoot = join(fixtureRoot, 'upstream-editor');
		mkdirSync(join(localRoot, 'browser'), { recursive: true });
		mkdirSync(join(upstreamRoot, 'browser'), { recursive: true });
		writeFileSync(join(localRoot, 'browser/editor.css'), '.stanza-editor { color: var(--ash-editor-foreground); }\n');
		writeFileSync(join(upstreamRoot, 'browser/editor.css'), '.monaco-editor { color: var(--vscode-editor-foreground); }\n');
		const result = auditEditorCssOwnership({
			repositoryRoot: fixtureRoot,
			localRoot,
			upstreamRoot,
			diff: [
				'diff --git a/app-ts/src/ash/editor/browser/editor.css b/app-ts/src/ash/editor/browser/editor.css',
				'--- a/app-ts/src/ash/editor/browser/editor.css',
				'+++ b/app-ts/src/ash/editor/browser/editor.css',
				'@@ -1 +1 @@',
				'-.monaco-editor { color: var(--vscode-editor-foreground); }',
				'+.stanza-editor { color: var(--ash-editor-foreground); }',
			].join('\n'),
			untrackedFiles: [],
		});
		assert.deepEqual(result.brandingEquivalent, ['browser/editor.css']);
		assert.deepEqual(result.changedBrandingEquivalent, ['browser/editor.css']);
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
