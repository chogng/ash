import type { Browser, BrowserContext, ConsoleMessage, ElectronApplication, Page, Request, Response, WebError } from '@playwright/test';
import { Disposable, toDisposable } from '../../src/ash/base/common/lifecycle.js';
import { Workbench } from './workbench.js';

export type PlaywrightApplication = Browser | ElectronApplication;

export interface WindowSize {
	readonly width: number;
	readonly height: number;
}

const FORBIDDEN_WORKBENCH_CONSOLE_ERRORS = ['[runtime]', 'App Server language document synchronization failed', 'Declarative extension refresh failed', 'Webview bootstrap failed'] as const;

/** Captures startup and subsequent window errors for one application generation. */
export class WorkbenchDiagnostics extends Disposable {
	public readonly pageErrors: string[] = [];
	public readonly consoleErrors: string[] = [];
	public readonly resourceErrors: string[] = [];
	private readonly failure = Promise.withResolvers<Error>();

	constructor(context: BrowserContext) {
		super();
		// Context events include new windows and survive navigation. Attach before
		// readiness so startup failures remain part of the scenario's result.
		const onConsole = (message: ConsoleMessage): void => {
			if (message.type() !== 'error') return;
			const text = message.text();
			this.consoleErrors.push(text);
			if (FORBIDDEN_WORKBENCH_CONSOLE_ERRORS.some(prefix => text.startsWith(prefix))) this.failure.resolve(new Error(text));
		};
		const onWebError = (event: WebError): void => {
			const error = event.error();
			this.pageErrors.push(error.stack ?? error.message);
			this.failure.resolve(error);
		};
		const recordResourceFailure = (request: Request, reason: string): void => {
			const url = new URL(request.url());
			// Desktop serves only bootstrap files on this scheme. Web builds emit the
			// same two assets; ordinary page and workspace requests are not fatal here.
			if (url.protocol !== 'ash-webview:'
				&& !/^\/assets\/(?:index-[\w-]+\.html|service-worker-[\w-]+\.js)$/u.test(url.pathname)
				&& !url.pathname.startsWith('/src/ash/workbench/contrib/webview/browser/pre/')) return;
			url.username = '';
			url.password = '';
			url.search = '';
			url.hash = '';
			const message = `Webview bootstrap request failed: ${reason} ${url.href}`;
			this.resourceErrors.push(message);
			this.failure.resolve(new Error(message));
		};
		const onResponse = (response: Response): void => {
			if (response.status() >= 400) recordResourceFailure(response.request(), `HTTP ${response.status()}`);
		};
		const onRequestFailed = (request: Request): void => {
			recordResourceFailure(request, request.failure()?.errorText ?? 'Request failed');
		};
		context.on('console', onConsole);
		this._register(toDisposable(() => context.off('console', onConsole)));
		context.on('weberror', onWebError);
		this._register(toDisposable(() => context.off('weberror', onWebError)));
		context.on('response', onResponse);
		this._register(toDisposable(() => context.off('response', onResponse)));
		context.on('requestfailed', onRequestFailed);
		this._register(toDisposable(() => context.off('requestfailed', onRequestFailed)));
		const onClose = (): void => { this.dispose(); };
		context.on('close', onClose);
		this._register(toDisposable(() => context.off('close', onClose)));
	}

	public get errors(): readonly string[] {
		return [...this.pageErrors, ...this.resourceErrors, ...this.consoleErrors.filter(message => FORBIDDEN_WORKBENCH_CONSOLE_ERRORS.some(prefix => message.startsWith(prefix)))];
	}

	/** Stop waiting for UI after a known failure, including service-worker errors without network events. */
	public async waitFor<T>(operation: () => Promise<T>): Promise<T> {
		const errors = this.errors;
		if (errors.length > 0) throw new Error(errors.join('\n\n'));
		return Promise.race([operation(), this.failure.promise.then(error => { throw error; })]);
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
