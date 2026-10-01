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
			send: (channel, ...args) => ipcRenderer.send(validateChannel(channel), ...args),
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
		ipcMessagePort: {
			acquire: (responseChannel, nonce) => {
				const channel = validateChannel(responseChannel);
				if (typeof nonce !== 'string' || nonce.length === 0) {
					throw new Error('Invalid MessagePort request nonce');
				}
				const handler = (event: Electron.IpcRendererEvent, response: unknown): void => {
					const responseNonce = typeof response === 'string'
						? response
						: typeof response === 'object' && response !== null && 'nonce' in response ? response.nonce : undefined;
					if (responseNonce !== nonce) { return; }
					ipcRenderer.removeListener(channel, handler);
					window.postMessage(response, '*', event.ports);
				};
				ipcRenderer.on(channel, handler);
				return { dispose: () => ipcRenderer.removeListener(channel, handler) };
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
})();
