# Ash

A workspace for code and AI agents.

Ash brings a code editor, agent conversations, and development tools into one
desktop app. Use the editor to work directly on your project, or open the Agents
window to give a task its own conversation. Prefer the terminal? Ash Code lets
you work with agents from the command line.

[User guide](https://github.com/chogng/ash-docs) · [Get started](#getting-started) · [Development](docs/README.md)

## What you can do

- **Work on your project.** Edit files, search code, review diffs, and use Git,
  terminals, and debugging tools alongside your conversations.
- **Give agents real tasks.** Ask them to explore a repository, make changes, or
  run commands. Follow their tool activity, respond to approval requests, and
  inspect the result before continuing.
- **Keep work in context.** Organize work into sessions and return to saved
  conversations. Desktop and Ash Code share local accounts, settings, and saved
  sessions when they use the same profile.
- **Choose your models and tools.** Configure model providers, add reusable
  Skills, and connect MCP servers for the tools your work needs.

## Desktop and terminal

**Ash** combines the editor and project tools with a dedicated Agents
window. Code and structured academic documents open in the same workspace.

**Ash Code** provides an interactive terminal interface, saved sessions, and
commands for asking questions or running tasks without an interactive UI. Once
the CLI is installed, run these from your project directory:

```sh
ash
ash app .
ash ask "Explain how this project is organized"
ash exec "Review the current changes and run the relevant tests"
```

`ash app .` opens the current project in the installed Ash desktop app;
`ash` opens the terminal interface. Use `ash app --app-path PATH .` to select
a desktop installation outside the standard locations.

## Getting started

1. Open your project in Ash, or start Ash Code in its directory.
2. Configure a model provider and select a model. Requests require valid
   credentials for the provider you choose.
3. Start with a task whose result you can check:

   ```text
   Find why the settings page does not refresh after saving. Fix the cause,
   run the relevant tests, and explain what changed.
   ```

The [user guide](https://github.com/chogng/ash-docs) covers sessions, Skills,
MCP servers, and permissions.

### Run from source

Prepare your tools and dependencies using the [build guide](docs/build.md#构建入口),
then run one of these commands from the repository root:

```sh
just ash       # Ash desktop app
just ash-code  # Ash Code terminal interface
```

Browser development and its connected/UI-only modes are described in the
[frontend guide](docs/frontend.md#启动项目). The browser entry is a local
development environment; Ash does not currently provide a hosted Web service.

## Development

Start with the [engineering documentation](docs/README.md) for setup, tests,
architecture, and component ownership. Desktop and Ash Code share a Rust
backend; the desktop interface is built with TypeScript, HTML, and CSS.

## License

Ash's original code and materials are proprietary and all rights reserved.
See [LICENSE](LICENSE). Third-party components are governed by their respective
licenses and [notices](THIRD_PARTY_NOTICES.md).
