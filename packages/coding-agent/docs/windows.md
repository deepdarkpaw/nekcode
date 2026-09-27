# Run nekcode on Windows

Run nekcode either as a native Windows process or inside Windows Subsystem for Linux (WSL). Native Windows uses Git Bash by default for Bash commands and can optionally expose PowerShell to the model. nekcode inside WSL uses the Linux environment and its Bash installation.

Follow the main [Quickstart](quickstart.md) to install and authenticate nekcode. Use this page to choose and configure its command environment.

## Choose native Windows or WSL

| Environment | Command environment | Use it when |
|---|---|---|
| Native Windows with Git Bash | Git Bash for the built-in `bash` tool and `!` commands | Files and development tools primarily live on Windows |
| Native Windows with the `powershell` tool | PowerShell for model tool calls; Bash remains available for `!` commands | The task depends on PowerShell modules or Windows-native commands |
| WSL | Linux Bash and tools inside the selected WSL distribution | Files and toolchains already live in Linux or WSL |

## Use Git Bash on native Windows

For most native Windows users, installing [Git for Windows](https://git-scm.com/download/win) is sufficient.

nekcode resolves Bash in this order:

1. `shellPath` from `~/.nek/agent/settings.json`
2. Git Bash under `Program Files` or `Program Files (x86)`
3. `bash.exe` on `PATH`, including Cygwin or MSYS2

Start nekcode and enter this command to verify the shell:

```text
!printf 'Bash is working\n'
```

If nekcode cannot find Bash, it reports the locations it checked. Install Git for Windows, put another Bash executable on `PATH`, or configure `shellPath`.

## Let the model use PowerShell

The optional `powershell` tool runs commands through `pwsh.exe` when available, then falls back to Windows PowerShell. It starts PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`.

To replace the model-facing `bash` tool with `powershell`, add this to `~/.nek/agent/settings.json`:

```json
{
  "defaultTools": ["read", "powershell", "edit", "write"]
}
```

Restart nekcode, then ask it to run a harmless PowerShell command. The `!` and `!!` editor commands continue to use Bash. The `powershell` tool is available only when nekcode runs as a native Windows process.

## Use a custom Bash executable

Set `shellPath` when Bash is installed somewhere nekcode does not discover automatically:

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

See [Configure shell commands](shell-aliases.md) for command prefixes and aliases.

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) and [Keybindings](keybindings.md) for Windows and WSL shortcut defaults.
