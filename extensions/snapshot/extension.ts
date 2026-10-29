import * as ash from '@ash/sdk';
import viewBundle from './browser/editor.ts?webview';

/** The extension owns the view and feature settings; the SDK supplies only admitted host capabilities. */
export function activate(context: ash.ExtensionContext): void {
	let assets: Promise<{ script: ash.Uri; style: ash.Uri }> | undefined;
	const urls: string[] = [];
	const resources = () =>
		(assets ??= (async () => {
			const bytes = Uint8Array.from(atob(viewBundle), character => character.charCodeAt(0));
			const decoded = (await new Response(
				new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
			).json()) as { script: string; style: string };
			const uri = (text: string, type: string) => {
				const url = URL.createObjectURL(new Blob([text], { type }));
				urls.push(url);
				return ash.Uri.parse(url);
			};
			return { script: uri(decoded.script, 'text/javascript'), style: uri(decoded.style, 'text/css') };
		})());
	context.subscriptions.push(
		ash.window.registerImageEditorProvider('snapshot.editor', {
			async resolveImageEditor(_input, view, token) {
				const { script, style } = await resources();
				if (token.isCancellationRequested) return;
				view.html = `<link rel="stylesheet" href="${view.asWebviewUri(style)}"><script src="${view.asWebviewUri(script)}"></script>`;
				const configuration = ash.workspace.getConfiguration('snapshot.code');
				view.setState({
					messages: { ...ash.l10n.bundle },
					accessibilityHints:
						ash.workspace.getConfiguration('accessibility.verbosity').get('chatScreenshot') !== false,
					help: (
						context.extension.packageJSON.contributes as { imageEditors: { accessibilityHelp: string }[] }
					).imageEditors[0].accessibilityHelp,
					code: Object.fromEntries(
						[
							'padding',
							'scale',
							'background',
							'lineNumbers',
							'realLineNumbers',
							'windowControls',
							'windowTitle',
							'transparent',
						].map(key => [key, configuration.get(key)]),
					) as ash.JsonValue,
				});
			},
		}),
	);
	context.subscriptions.push(
		ash.commands.register('snapshot.code', () =>
			ash.window.showImageEditor('snapshot.editor', { source: 'selection' }),
		),
	);
	context.subscriptions.push(
		new ash.Disposable(() => {
			for (const url of urls) URL.revokeObjectURL(url);
		}),
	);
}
