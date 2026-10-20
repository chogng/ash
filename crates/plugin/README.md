# Plugin

- Consumes shared Plugin identities and package discovery from [`ash-utils-plugins`](../utils/plugins/README.md).
- Defines the `.ash-plugin` package format, contribution paths and permissions.
- Validates one package observation and computes its deterministic content identity.
- Contains no installation, Extensions, activation, credential or runtime lifecycle.

JavaScript editor-extension manifests admit the implemented command, language, status-bar,
Task-provider and Debug capabilities. Task and Debug callbacks still use the Workbench
owners and their process boundaries. Ash SDK V8 remains confined; `api: ash` Node
packages require the separate Node execution contract and have user-level IO after authorization.
The old `vscode` API and omitted API value decode only as retired metadata for management;
they cannot be installed, enabled, granted or executed.
Activation selectors must stay within the declared
capability ceiling. Other provider kinds remain excluded until their SDK/runtime chain
is implemented.
