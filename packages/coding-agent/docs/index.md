# nekcode documentation

nekcode is an extensible terminal coding agent. It can inspect files, run commands, edit content, manage sessions, and delegate bounded work to subagents.

## Start using nekcode

New to nekcode? Follow the [Quickstart](quickstart.md) to install it, connect a model, and complete your first task.

If nekcode is already installed:

- [Use nekcode interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure nekcode](configuration.md) for preferences, working folders, instructions, and reusable resources.
- [Understand how nekcode works](how-nek-works.md), including tools, context, sessions, and the agent loop.
- [Use nekcode planning and subagents](nek.md): plan mode, todos, delegated subagents, and the built-in file tools.

## Customize nekcode

nekcode can reuse prompts, load specialized instructions, add explicit extensions, change its terminal interface, connect model services, and load themes.

- [MCP servers](mcp.md): connect tools and resources, configure discovery, and manage OAuth.
- [Extensions](extensions.md)
- [Skills](skills.md)
- [Prompt templates](prompt-templates.md)
- [Themes](themes.md)
- [Terminal UI](tui.md)

## Automate or embed nekcode

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate nekcode process.
- Use the [TypeScript SDK](sdk.md) to run nekcode inside an application.

## Reference and platform setup

Use the reference pages for [CLI options](cli.md), [settings](settings.md), [provider authentication](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Safety

Tools and explicit extensions run with the permissions of the nekcode process. Project trust controls which project resources are loaded; it is not a sandbox. Review [Security](security.md) before using untrusted files, repositories, extensions, or unattended automation.
