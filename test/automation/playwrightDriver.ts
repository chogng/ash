import type { Browser, BrowserContext, ConsoleMessage, ElectronApplication, Page, WebError } from "@playwright/test";
import { Disposable, toDisposable } from '../../src/ash/base/common/lifecycle.js';
import { Workbench } from "./workbench.js";

export type PlaywrightApplication = Browser | ElectronApplication;

export interface WindowSize {
	readonly width: number;
	readonly height: number;
}

const FORBIDDEN_WORKBENCH_CONSOLE_ERRORS = ["[runtime]", "App Server language document synchronization failed", "Declarative extension refresh failed"] as const;

/** Captures startup and subsequent window errors for one application generation. */
export class WorkbenchDiagnostics extends Disposable {
	public readonly pageErrors: string[] = [];
	public readonly consoleErrors: string[] = [];

	constructor(context: BrowserContext) {
		super();
		// Context events include new windows and survive navigation. Attach before
		// readiness so startup failures remain part of the scenario's result.
		const onConsole = (message: ConsoleMessage): void => { if (message.type() === 'error') this.consoleErrors.push(message.text()); };
		const onWebError = (event: WebError): void => { const error = event.error(); this.pageErrors.push(error.stack ?? error.message); };
		context.on('console', onConsole);
		this._register(toDisposable(() => context.off('console', onConsole)));
		context.on('weberror', onWebError);
		this._register(toDisposable(() => context.off('weberror', onWebError)));
		const onClose = (): void => { this.dispose(); };
		context.on('close', onClose);
		this._register(toDisposable(() => context.off('close', onClose)));
	}

	public get errors(): readonly string[] {
		return [...this.pageErrors, ...this.consoleErrors.filter(message => FORBIDDEN_WORKBENCH_CONSOLE_ERRORS.some(prefix => message.startsWith(prefix)))];
	}
}

/** Small Workbench-facing driver shared by Browser and Electron end-to-end tests. */
export class PlaywrightDriver {
	readonly workbench: Workbench;

	constructor(
		readonly application: PlaywrightApplication,
		readonly currentPage: Page,
		readonly diagnostics: WorkbenchDiagnostics,
	) {
		this.workbench = new Workbench(currentPage);
	}

	async setWindowSize(size: WindowSize): Promise<WindowSize> {
		await this.currentPage.setViewportSize(size);
		await this.currentPage.waitForFunction(
			requestedSize => window.innerWidth === requestedSize.width && window.innerHeight === requestedSize.height,
			size,
		);
		await this.workbench.waitForUiIdle();
		return size;
	}
}
