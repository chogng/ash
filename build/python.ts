import { spawn } from 'node:child_process';

export function pythonCommand(args: string[]): { command: string; args: string[] } {
	return { command: process.platform === 'win32' ? 'python' : 'python3', args };
}

if (import.meta.main) {
	const { command, args } = pythonCommand(process.argv.slice(2));
	const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
	child.once('error', error => {
		console.error(error);
		process.exitCode = 1;
	});
	child.once('close', (code, signal) => {
		process.exitCode = signal ? 1 : (code ?? 1);
	});
}
