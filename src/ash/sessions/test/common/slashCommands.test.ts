import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DesktopSlashCommands as WorkbenchCommands, parseSlashCommandInput as parseWorkbench, SlashCommandCatalog as WorkbenchCatalog } from '../../../workbench/contrib/chat/common/slashCommands.js';
import { DesktopSlashCommands, parseSlashCommandInput, SlashCommandCatalog } from '../../contrib/cowork/common/slashCommands.js';

const workbenchCatalog = new WorkbenchCatalog(WorkbenchCommands, []);
const sessionsCatalog = new SlashCommandCatalog(DesktopSlashCommands, []);

for (const { host, catalog, parse } of [
	{ host: 'IDE', catalog: workbenchCatalog, parse: (value: string) => parseWorkbench(value, workbenchCatalog) },
	{ host: 'Agents', catalog: sessionsCatalog, parse: (value: string) => parseSlashCommandInput(value, sessionsCatalog) },
]) {
	test(`${host} discovers Extensions through the sidebar and preserves old slash bindings`, () => {
		assert.ok(catalog.matching('').some(command => command.name === 'skills'));
		assert.ok(catalog.matching('plugins').some(command => command.name === 'plugins'));
		assert.ok(!catalog.commands.some(command => command.name === 'extensions'));
		assert.ok(!catalog.matching('extensions').some(command => command.name === 'extensions'));
		assert.equal(parse('/extensions').kind, 'command');
		assert.equal(parse('/plugins').kind, 'command');
	});
}
