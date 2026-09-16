import type { RemoteRuntimeInstallProgressState } from "../../../platform/remote/common/remoteRuntimeInstallProgress.js";
import { addDisposableListener } from "../../../base/browser/dom.js";
import { DisposableStore } from "../../../base/common/lifecycle.js";
import { createRemoteRuntimeInstallProgressApi } from "../../../platform/remote/electron-browser/remoteRuntimeInstallProgressApi.js";
import { bindColorTheme } from "../../../platform/theme/browser/themeStyles.js";
import { darkColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { lightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import type { IThemeService } from "../../../platform/theme/common/themeService.js";
import type { IColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { Emitter } from "../../../base/common/event.js";

const api = createRemoteRuntimeInstallProgressApi();
const resources = new DisposableStore();
const preferredColorScheme = window.matchMedia("(prefers-color-scheme: light)");
const themeChanges = resources.add(new Emitter<IColorTheme>());
const themeService: IThemeService = {
	onDidColorThemeChange: themeChanges.event,
	getColorTheme: () => preferredColorScheme.matches ? lightColorTheme : darkColorTheme,
};
resources.add(bindColorTheme(themeService, document.documentElement));
const host = requiredElement("remote-install-host", HTMLParagraphElement);
const stage = requiredElement("remote-install-stage", HTMLParagraphElement);
const progress = requiredElement("remote-install-progress", HTMLProgressElement);
const detail = requiredElement("remote-install-detail", HTMLParagraphElement);
const cancel = requiredElement("remote-install-cancel", HTMLButtonElement);

resources.add(api.onDidChange(render));
const updateColorScheme = (): void => themeChanges.fire(themeService.getColorTheme());
resources.add(addDisposableListener(preferredColorScheme, "change", updateColorScheme));
resources.add(addDisposableListener(window, "beforeunload", () => resources.dispose(), { once: true }));
resources.add(addDisposableListener(cancel, "click", () => {
	cancel.disabled = true;
	cancel.textContent = "Cancelling…";
	void api.cancel().catch(error => {
		stage.textContent = "Could not cancel Remote startup";
		detail.textContent = error instanceof Error ? error.message : String(error);
		cancel.disabled = false;
		cancel.textContent = "Try Again";
	});
}));

render(await api.getState());

function render(state: RemoteRuntimeInstallProgressState | undefined): void {
	if (!state) {
		stage.textContent = "Finishing Remote startup…";
		detail.textContent = "The compatible runtime is ready. Ash is opening the Workspace.";
		progress.value = 100;
		cancel.disabled = true;
		return;
	}
	host.textContent = `SSH host: ${state.host}`;
	cancel.disabled = state.status === "cancelling";
	cancel.textContent = state.status === "cancelling" ? "Cancelling…" : "Cancel Remote Startup";
	if (state.status === "cancelling") {
		stage.textContent = "Cancelling Remote startup…";
		detail.textContent = "Stopping the local installer and its SSH operation.";
		progress.removeAttribute("value");
		return;
	}
	switch (state.phase) {
		case "downloadingCatalog":
			showIndeterminate("Checking runtime release…", "Downloading the catalog bound to this signed Ash release.");
			break;
		case "downloadingArtifact": {
			const percent = Math.floor(state.transferredBytes * 100 / state.totalBytes);
			stage.textContent = `Downloading runtime… ${percent}%`;
			detail.textContent = `${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)} downloaded to the local cache.`;
			progress.value = percent;
			break;
		}
		case "validatingDownload":
			showIndeterminate("Validating downloaded runtime…", "Checking its exact size, SHA-256, archive shape, and package metadata.");
			break;
		case "downloadComplete":
			stage.textContent = state.disposition === "reused" ? "Cached runtime verified" : "Runtime download complete";
			detail.textContent = "Preparing the authenticated package for SSH installation.";
			progress.value = 100;
			break;
		case "validatingArtifact":
			showIndeterminate("Validating runtime package…", "Checking the signed package metadata and archive integrity.");
			break;
		case "probingPlatform":
			showIndeterminate("Detecting Remote platform…", "Selecting the compatible Linux or macOS runtime package.");
			break;
		case "uploading": {
			const percent = Math.floor(state.transferredBytes * 100 / state.totalBytes);
			stage.textContent = `Uploading runtime… ${percent}%`;
			detail.textContent = `${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)} transferred over SSH.`;
			progress.value = percent;
			break;
		}
		case "finalizingRemoteInstall":
			showIndeterminate("Finalizing Remote installation…", "Verifying and committing the immutable runtime on the Remote host.");
			break;
		case "complete":
			stage.textContent = state.disposition === "reused" ? "Compatible runtime already installed" : "Remote runtime installed";
			detail.textContent = "Ash is verifying the exact executable before starting the Remote App Server.";
			progress.value = 100;
			cancel.disabled = true;
			break;
	}
}

function showIndeterminate(message: string, explanation: string): void {
	stage.textContent = message;
	detail.textContent = explanation;
	progress.removeAttribute("value");
}

function formatBytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function requiredElement<TElement extends HTMLElement>(id: string, constructor: abstract new (...args: never[]) => TElement): TElement {
	const element = document.getElementById(id);
	if (!(element instanceof constructor)) throw new Error(`Remote runtime installation page is missing #${id}`);
	return element;
}
