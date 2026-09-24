export interface FileIconDefinition {
	readonly character: string;
	readonly color: string;
	readonly fontFamily: string;
	readonly fontSize: string;
	readonly image: string;
}

export interface IWorkbenchFileIconTheme {
	readonly id: string;
	readonly label: string;
	readonly styleSheetContent: string;
	resolveFileIcon(name: string, dark: boolean): FileIconDefinition | undefined;
}

