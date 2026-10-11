# Security Policy

Thank you for helping keep Ash secure!

## Reporting a vulnerability

Do not report security vulnerabilities in public GitHub issues, pull requests, or Discussions.

Use the repository's **Security** tab and private vulnerability reporting flow when available. Include enough information to reproduce and assess the issue, such as:

- affected Ash surface and version;
- affected operating system or environment;
- reproduction steps;
- security impact;
- relevant logs or proof of concept with secrets and personal data removed.

If private vulnerability reporting is not enabled, do not publish vulnerability details publicly. Contact the repository maintainer privately before disclosure.

## Scope

Security-sensitive areas include, but are not limited to:

- process execution, shell and PTY handling;
- sandbox and filesystem boundaries;
- credentials, OAuth and provider authentication;
- MCP, plugins, connectors and external capability execution;
- workspace trust and permission handling;
- update, package and Extensions trust boundaries.
