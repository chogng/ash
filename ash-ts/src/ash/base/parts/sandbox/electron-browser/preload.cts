(function () {
	const { contextBridge, ipcRenderer, webUtils } =
		require("electron") as typeof import("electron");
	type ISandboxGlobals =
		import("./sandboxTypes.js").ISandboxGlobals;

	const validateChannel = (channel: string): string => {
		if (!channel?.startsWith("ash:")) {
			throw new Error(`Unsupported IPC channel '${channel}'`);
		}
		return channel;
	};

	const globals: ISandboxGlobals = {
		ipcRenderer: {
			invoke: (channel, params) =>
				ipcRenderer.invoke(validateChannel(channel), params),
			on: (channel, listener) => {
				const validatedChannel = validateChannel(channel);
				const handler = (
					_event: Electron.IpcRendererEvent,
					value: unknown,
				): void => listener(value);
				ipcRenderer.on(validatedChannel, handler);
				return {
					dispose: () =>
						ipcRenderer.removeListener(validatedChannel, handler),
				};
			},
		},
		process: {
			platform: process.platform,
			arch: process.arch,
		},
		webUtils: {
			getPathForFile: (file) => webUtils.getPathForFile(file),
		},
	};

	contextBridge.exposeInMainWorld("ash", globals);
	ipcRenderer.on('ash:app-server:port', (_event, value: unknown) => {
		if (typeof value !== 'object' || value === null || !('nonce' in value) || typeof value.nonce !== 'string' || _event.ports.length !== 1) { return; }
		window.postMessage({ type: 'ash:app-server:port', nonce: value.nonce }, '*', _event.ports);
	});
})();
