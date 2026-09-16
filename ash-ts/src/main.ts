import { bootstrapElectronMain } from "./bootstrap.js";
import { app } from "electron/main";

try {
	bootstrapElectronMain();
	await import("./ash/code/electron-main/main.js");
} catch (error) {
	console.error("Failed to initialize Ash", error);
	app.exit(1);
}
