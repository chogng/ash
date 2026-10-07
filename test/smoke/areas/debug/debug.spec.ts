import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

// Exercise the production stdio transport with a deterministic DAP peer. The
// peer records requests so UI assertions also prove which container was edited.
const adapter = String.raw`
const fs = require('node:fs');
const source = process.argv[2];
const requests = process.argv[3];
let buffer = Buffer.alloc(0);
let sequence = 1;
let line = 2;
let answer = '42';
let child = '1';
function send(message) {
  const body = Buffer.from(JSON.stringify({ seq: sequence++, ...message }));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function event(event, body) { send({ type: 'event', event, body }); }
function accept(request) {
  fs.appendFileSync(requests, JSON.stringify(request) + '\n');
  const args = request.arguments || {};
  let body = {};
  let success = true;
  if (request.command === 'initialize') body = { supportsConfigurationDoneRequest: true, supportsSetVariable: true, supportsConditionalBreakpoints: true, supportsHitConditionalBreakpoints: true, supportsLogPoints: true, supportsFunctionBreakpoints: true, supportsDataBreakpoints: true, supportsInstructionBreakpoints: true, supportsDisassembleRequest: true, supportsSteppingGranularity: true };
  if (request.command === 'launch') event('initialized', {});
  if (request.command === 'threads') body = { threads: [{ id: 7, name: 'main' }] };
  if (request.command === 'stackTrace') body = { stackFrames: [{ id: 11, name: 'main', source: { name: 'debug-program.js', path: source }, line, column: 1, instructionPointerReference: '0x' + (0x1000 + (line - 2) * 4).toString(16) }] };
  if (request.command === 'disassemble') body = { instructions: Array.from({ length: args.instructionCount }, (_, index) => ({ address: '0x' + (Number(args.memoryReference) + args.offset + (args.instructionOffset + index) * 4).toString(16), instructionBytes: '90', instruction: 'mov r0, r1', location: { name: 'debug-program.js', path: source }, line: 2, column: 1 })) };
  if (request.command === 'scopes') body = { scopes: [{ name: 'Locals', variablesReference: 10, expensive: false }] };
  if (request.command === 'variables') body = { variables: args.variablesReference === 10 ? [
    { name: 'answer', value: answer, variablesReference: 0 },
    { name: 'object', value: 'Object', variablesReference: 20 },
    { name: 'locked', value: '1', variablesReference: 0, presentationHint: { attributes: ['readOnly'] } }
  ] : [{ name: 'child', value: child, variablesReference: 0 }] };
  if (request.command === 'evaluate') body = { result: answer, variablesReference: 0 };
  if (request.command === 'setBreakpoints') body = { breakpoints: args.breakpoints.map(point => ({ line: point.line, verified: true })) };
  if (['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints'].includes(request.command)) body = { breakpoints: args.breakpoints.map(() => ({ verified: true })) };
  if (request.command === 'dataBreakpointInfo') body = { dataId: 'memory:' + args.name, description: args.name, accessTypes: ['read', 'write', 'readWrite'], canPersist: false };
  if (request.command === 'setVariable') {
    success = /^\d+$/.test(args.value);
    if (success) {
      if (args.variablesReference === 10 && args.name === 'answer') answer = args.value;
      else if (args.variablesReference === 20 && args.name === 'child') child = args.value;
      else throw new Error('Unexpected setVariable address');
      body = { value: args.value };
    }
  }
  send({ type: 'response', request_seq: request.seq, command: request.command, success, body, ...(success ? {} : { message: 'Value must be numeric.' }) });
  if (request.command === 'configurationDone') {
    event('output', { category: 'console', output: 'ASH_DEBUG_READY\n' });
    event('stopped', { reason: 'breakpoint', threadId: 7, allThreadsStopped: true });
  }
  if (request.command === 'next') {
    line++;
    event('continued', { threadId: 7, allThreadsContinued: true });
    event('stopped', { reason: 'step', threadId: 7, allThreadsStopped: true });
  }
  if (request.command === 'disconnect') {
    event('terminated', {});
    process.stdout.end(() => process.exit(0));
  }
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]);
    const end = headerEnd + 4 + length;
    if (buffer.length < end) return;
    const request = JSON.parse(buffer.subarray(headerEnd + 4, end).toString());
    buffer = buffer.subarray(end);
    accept(request);
  }
});
`;

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires the Code DAP process boundary.');
	const directory = testWorkspace.directory;
	await mkdir(join(directory, '.vscode'));
	await writeFile(join(directory, 'debug-adapter.cjs'), adapter);
	await writeFile(join(directory, 'debug-program.js'), 'const answer = 42;\nconsole.log(answer);\nconsole.log("finished");\n');
	await writeFile(join(directory, 'debug-requests.jsonl'), '');
	await writeFile(join(directory, '.vscode', 'launch.json'), JSON.stringify({
		version: '0.2.0', configurations: [{
			name: 'Debug smoke', type: 'smoke', request: 'launch',
			debugAdapter: { program: process.execPath, args: [join(directory, 'debug-adapter.cjs'), join(directory, 'debug-program.js'), join(directory, 'debug-requests.jsonl')] },
		}]
	}));
});

test('debugging locates stopped source, edits nested variables by keyboard, refreshes watches, steps and stops', async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	await page.getByRole('tab', { name: 'Run and Debug', exact: true }).first().click();
	const pane = page.locator('[data-view-id="workbench.view.debug"]');
	await expect(pane.getByRole('combobox', { name: 'Debug configuration', exact: true })).toContainText('Debug smoke');
	await pane.getByRole('button', { name: 'Start Debugging', exact: true }).click();
	await expect(pane.getByRole('status')).toContainText('stopped');
	await expect(pane.locator('.ash-debug-frame')).toContainText('debug-program.js:2');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('console.log(answer)'));
	await expect(page.getByRole('tab', { name: 'debug-program.js', exact: true, selected: true })).toContainText('debug-program.js');
	await workbench.quickaccess.runCommand('editor.debug.action.toggleBreakpoint');
	const breakpoint = pane.locator('.ash-debug-breakpoints > li').filter({ hasText: 'debug-program.js:2' });
	await expect(breakpoint).toBeVisible();
	await breakpoint.getByRole('button', { name: 'Edit breakpoint', exact: true }).click();
	await pane.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('answer > 0');
	await pane.getByRole('textbox', { name: 'Hit count condition', exact: true }).fill('>= 2');
	await pane.getByRole('textbox', { name: 'Log message', exact: true }).fill('answer={answer}');
	await pane.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	const breakpointRequests = async () => (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: { breakpoints?: unknown[]; }; }).filter(request => request.command === 'setBreakpoints');
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([{ line: 2, condition: 'answer > 0', hitCondition: '>= 2', logMessage: 'answer={answer}' }]);
	await breakpoint.getByRole('checkbox').uncheck();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([]);
	await pane.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([{ line: 2, condition: 'answer > 0', hitCondition: '>= 2', logMessage: 'answer={answer}' }]);
	await pane.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	await expect.poll(async () => (await breakpointRequests()).at(-1)?.arguments?.breakpoints).toEqual([]);

	const lastArguments = async (command: string) => (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; }).filter(request => request.command === command).at(-1)?.arguments;
	await pane.getByRole('button', { name: 'Add Function Breakpoint', exact: true }).click();
	const functionName = pane.getByRole('textbox', { name: 'Function name', exact: true });
	await functionName.fill('main');
	await pane.getByRole('textbox', { name: 'Expression condition', exact: true }).fill('answer > 0');
	await functionName.press('Enter');
	await expect.poll(() => lastArguments('setFunctionBreakpoints')).toEqual({ breakpoints: [{ name: 'main', condition: 'answer > 0' }] });
	await pane.getByRole('button', { name: 'Break on data access for answer', exact: true }).click();
	await pane.getByRole('combobox', { name: 'Break on access', exact: true }).selectOption('readWrite');
	await pane.getByRole('button', { name: 'Save breakpoint', exact: true }).click();
	await expect.poll(() => lastArguments('dataBreakpointInfo')).toEqual({ name: 'answer', variablesReference: 10, frameId: 11 });
	await expect.poll(() => lastArguments('setDataBreakpoints')).toEqual({ breakpoints: [{ dataId: 'memory:answer', accessType: 'readWrite' }] });
	await pane.getByRole('button', { name: 'Add Instruction Breakpoint', exact: true }).click();
	await expect(pane.getByRole('textbox', { name: 'Instruction address', exact: true })).toHaveValue('0x1000');
	const instructionOffset = pane.getByRole('textbox', { name: 'Instruction byte offset', exact: true });
	await instructionOffset.fill('-4');
	await instructionOffset.press('Enter');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1000', offset: -4 }] });
	await pane.getByRole('button', { name: 'Disable All Breakpoints', exact: true }).click();
	for (const command of ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints']) {
		await expect.poll(() => lastArguments(command)).toEqual({ breakpoints: [] });
	}
	await pane.getByRole('button', { name: 'Enable All Breakpoints', exact: true }).click();
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1000', offset: -4 }] });
	await pane.getByRole('button', { name: 'Remove All Breakpoints', exact: true }).click();
	for (const command of ['setFunctionBreakpoints', 'setDataBreakpoints', 'setInstructionBreakpoints']) {
		await expect.poll(() => lastArguments(command)).toEqual({ breakpoints: [] });
	}

	await pane.getByRole('button', { name: 'Add watch expression', exact: true }).click();
	await pane.getByRole('textbox', { name: 'Add watch expression' }).fill('answer');
	await pane.getByRole('textbox', { name: 'Add watch expression' }).press('Enter');
	await expect(pane.locator('.ash-debug-watch-value')).toHaveText('answer = 42');
	const answer = pane.locator('.ash-debug-variable').filter({ hasText: 'answer =' });
	await answer.focus();
	await answer.press('F2');
	const value = pane.getByRole('textbox', { name: 'Value of answer', exact: true });
	await expect(value).toBeFocused();
	await value.fill('100');
	await value.press('Escape');
	await expect(answer).toBeFocused();
	await expect(answer).toContainText('answer = 42');
	await answer.press('F2');
	await value.fill('invalid');
	await value.press('Enter');
	await expect(value).toHaveAttribute('aria-invalid', 'true');
	await expect(pane.getByRole('alert').filter({ hasText: 'Value must be numeric.' })).toHaveText('Value must be numeric.');
	await expect(value).toBeFocused();
	await value.fill('43');
	await value.press('Enter');
	await expect(answer).toContainText('answer = 43');
	await expect(answer).toBeFocused();
	await expect(pane.locator('.ash-debug-watch-value')).toHaveText('answer = 43');

	const locked = pane.locator('.ash-debug-variable').filter({ hasText: 'locked =' });
	await locked.focus();
	await locked.press('F2');
	await expect(pane.locator('.ash-debug-variable-edit')).toHaveCount(0);
	await pane.locator('.ash-debug-variable').filter({ hasText: 'object = Object' }).click();
	const child = pane.locator('.ash-debug-variable').filter({ hasText: 'child =' });
	await expect(child).toContainText('child = 1');
	await child.dblclick();
	await pane.getByRole('textbox', { name: 'Value of child', exact: true }).fill('2');
	await pane.getByRole('textbox', { name: 'Value of child', exact: true }).press('Enter');
	await expect(child).toContainText('child = 2');
	await expect(child).toBeFocused();

	await pane.getByRole('button', { name: 'Step Over', exact: true }).click();
	await expect(pane.locator('.ash-debug-frame')).toContainText('debug-program.js:3');
	await expect(pane.locator('.ash-debug-variable').filter({ hasText: 'answer =' })).toContainText('answer = 43');
	await pane.getByRole('button', { name: 'Open Disassembly View', exact: true }).click();
	const disassembly = page.locator('.ash-disassembly');
	const instructions = disassembly.getByRole('grid', { name: 'Disassembly', exact: true });
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await expect(disassembly.locator('[data-instruction-address="0x1004"]')).toHaveAttribute('aria-current', 'step');
	await expect.poll(() => lastArguments('disassemble')).toEqual({ memoryReference: '0x1004', offset: 0, instructionOffset: 0, instructionCount: 50, resolveSymbols: true });
	await instructions.focus();
	await instructions.press('F9');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [{ instructionReference: '0x1004', offset: 0 }] });
	await instructions.press('F9');
	await expect.poll(() => lastArguments('setInstructionBreakpoints')).toEqual({ breakpoints: [] });
	await disassembly.getByRole('button', { name: 'Next instructions', exact: true }).click();
	await expect.poll(() => lastArguments('disassemble')).toEqual({ memoryReference: '0x1004', offset: 0, instructionOffset: 50, instructionCount: 50, resolveSymbols: true });
	await disassembly.getByRole('button', { name: 'Current instruction', exact: true }).click();
	await expect(disassembly.locator('[data-instruction-address="0x1004"]')).toBeVisible();
	await disassembly.getByRole('button', { name: 'Open instruction source', exact: true }).click();
	await expect(page.getByRole('tab', { name: 'debug-program.js', exact: true, selected: true })).toBeVisible();
	await workbench.quickaccess.runCommand('debug.action.openDisassemblyView');
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true })).toHaveCount(1);
	await instructions.focus();
	await instructions.press('Alt+F1');
	const help = page.getByRole('textbox', { name: 'Accessibility Help', exact: true });
	await expect(help).toHaveValue(/Press F9 to toggle its instruction breakpoint/);
	await help.press('Escape');
	await expect(instructions).toBeFocused();
	await instructions.press('Alt+F2');
	const accessible = page.getByRole('textbox', { name: 'Accessible View', exact: true });
	await expect(accessible).toHaveValue(/Current instruction: 0x1004/);
	await accessible.press('Escape');
	await expect(instructions).toBeFocused();
	await instructions.press('F10');
	await expect.poll(() => lastArguments('next')).toEqual({ threadId: 7, granularity: 'instruction' });
	await expect(disassembly.locator('[data-instruction-address="0x1008"]')).toHaveAttribute('aria-current', 'step');
	await expect(page.getByRole('tab', { name: 'Disassembly', exact: true, selected: true })).toBeVisible();
	await pane.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(disassembly.getByRole('status')).toHaveText('Pause debugging to view disassembly.');
	await expect(disassembly.locator('[data-instruction-address]')).toHaveCount(0);
	await expect(pane.locator('.ash-debug-frame, .ash-debug-variable')).toHaveCount(0);
	await expect(pane.getByRole('toolbar', { name: 'Debug controls' })).toBeHidden();
	const requests = (await readFile(join(testWorkspace.directory, 'debug-requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { command: string; arguments?: unknown; });
	expect(requests.filter(request => request.command === 'setVariable').map(request => request.arguments)).toEqual([
		{ variablesReference: 10, name: 'answer', value: 'invalid' },
		{ variablesReference: 10, name: 'answer', value: '43' },
		{ variablesReference: 20, name: 'child', value: '2' },
	]);
	expect(requests.some(request => request.command === 'disconnect')).toBe(true);
});
