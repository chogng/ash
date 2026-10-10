# Plugin

- Defines `name@marketplace` Plugin identities with shared construction and serialization validation.
- Defines the `.ash-plugin` package format, its publisher-owned package identity, contribution paths and permissions.
- Validates one package observation and computes its deterministic content identity.
- Contains no installation, Marketplace, activation, credential or runtime lifecycle.


JavaScript editor-extension manifests admit the implemented command, language, status-bar,
Task-provider and Debug capabilities. Task and Debug callbacks still use the Workbench
owners and their process boundaries. Ash SDK V8 remains confined; standard `api: vscode`
packages require the separate Node execution contract and have user-level IO after authorization.
Activation selectors must stay within the declared
capability ceiling. Other provider kinds remain excluded until their SDK/runtime chain
is implemented.
