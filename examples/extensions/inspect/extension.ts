import * as ash from '@ash/sdk';

export function activate(context: ash.ExtensionContext): void {
	context.subscriptions.push(
		ash.commands.register('ash.example.inspect', async (path: unknown) => {
			if (typeof path !== 'string') throw new TypeError('Expected a workspace file path');
			return ash.files.readTextFile(path);
		}),
	);
}
