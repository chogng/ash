import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repositoryRoot = resolve(skillDirectory, '../../..');
const ledgerPath = resolve(repositoryRoot, 'app-ts/src/ash/editor/api-alignment-status.md');
const ledger = readFileSync(ledgerPath, 'utf8');

const handled = readDeclarations(ledger, '已处理的同名契约');
const pending = readDeclarations(ledger, '尚未补齐的同名契约');
const all = [...handled, ...pending];
const unique = new Set(all);
const summary = /(?:当前表格记录|初始确认)\s+(\d+)\s+组.*?已处理\s+(\d+)\s+组，剩余\s+(\d+)\s+组/u.exec(ledger);
if (!summary) throw new Error('Missing total, handled, and pending counts in the ledger summary');
const [, totalText, handledText, pendingText] = summary;

assertCount('已处理', handled.length, Number(handledText));
assertCount('待处理', pending.length, Number(pendingText));
assertCount('总计', all.length, Number(totalText));
assertCount('唯一声明', unique.size, all.length);

process.stdout.write(`Editor API ledger: ${handled.length} handled + ${pending.length} pending = ${all.length}\n`);

function readDeclarations(markdown, heading) {
	const start = markdown.indexOf(`## ${heading}`);
	if (start < 0) throw new Error(`Missing ledger heading: ${heading}`);
	const sectionStart = markdown.indexOf('\n', start);
	const nextHeading = markdown.indexOf('\n## ', sectionStart + 1);
	const section = markdown.slice(sectionStart, nextHeading < 0 ? markdown.length : nextHeading);
	const declarations = [];
	for (const line of section.split(/\r?\n/u)) {
		if (!line.startsWith('| `')) continue;
		const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
		if (cells.length < 2) continue;
		const file = unwrapCode(cells[0]);
		for (const declaration of cells[1].split('、').map(unwrapCode)) {
			if (!declaration) throw new Error(`Empty declaration in ${file}`);
			declarations.push(`${file}::${declaration}`);
		}
	}
	return declarations;
}

function unwrapCode(value) {
	return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
}

function assertCount(label, actual, expected) {
	if (actual !== expected) throw new Error(`${label} count must be ${expected}, got ${actual}`);
}
