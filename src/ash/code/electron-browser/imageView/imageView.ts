import { openImageViewWindow } from '../../../platform/imageView/electron-browser/imageViewWindow.js';
import { defaultImageEditorTheme } from '../../../workbench/services/imageEditor/browser/imageEditorTheme.js';

await openImageViewWindow(async ({ locale, presentation }) => {
	const { default: assets } = await import('virtual:ash-snapshot-view');
	const chinese = locale.toLowerCase() === 'zh-cn';
	const messages = chinese ? assets.zh : assets.en;
	return {
		title: messages.displayName,
		html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src data:"><style>${assets.style.replace(/<\/style/gi, '<\\/style')}</style><script>${assets.script.replace(/<\/script/gi, '<\\/script')}</script>`,
		input: {
			...presentation.input,
			state: { messages: chinese ? assets.messages : {}, help: messages['capture.help'], accessibilityHints: presentation.input.accessibilityHints },
			theme: defaultImageEditorTheme(presentation.input.colorScheme),
		},
	};
});
