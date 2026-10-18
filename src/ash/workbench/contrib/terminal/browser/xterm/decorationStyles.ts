import { localize } from '../../../../../nls.js';
import type { ITerminalCommandStatusEvent } from '../terminal.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';

/** Match VS Code's decoration box; the circle artwork occupies half its width. */
export function updateLayout(configurationService: IConfigurationService, element: HTMLElement): void {
	const font = configurationService.inspect<number>('terminal.integrated.fontSize');
	const lineHeight = configurationService.getValue<number>('terminal.integrated.lineHeight');
	const scale = Math.min(1, font.value! / font.defaultValue!);
	const size = 16 * scale;
	// xterm owns row placement and supplies inline cell dimensions on every render.
	// Override only the decoration box, leaving its visibility and position intact.
	element.style.width = `${size}px`;
	element.style.height = `${size * lineHeight}px`;
	element.style.fontSize = `${size}px`;
	element.style.marginLeft = `${-17 * scale}px`;
}

/** Status text comes from committed backend events; command text is never evaluated. */
export function getTerminalCommandDecorationTooltip(command: ITerminalCommandStatusEvent): string {
	switch (command.status) {
		case 'running': return localize('terminal.command.running', 'Command is running');
		case 'completed': return localize('terminal.command.completed', 'Command completed; exit code unavailable');
		case 'succeeded': return localize('terminal.command.succeeded', 'Command completed successfully');
		case 'failed': return command.exitCode === undefined
			? localize('terminal.command.failed', 'Command failed')
			: localize('terminal.command.failedCode', 'Command failed with exit code {0}', command.exitCode);
		case 'canceled': return localize('terminal.command.canceled', 'Command was canceled');
	}
}
