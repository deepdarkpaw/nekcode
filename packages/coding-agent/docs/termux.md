# Run nekcode on Android with Termux

nekcode runs on Android through [Termux](https://termux.dev/), a terminal emulator and Linux environment. Text input, file tools, and shell commands are supported. nekcode can copy and paste text through Termux:API; clipboard image paste is not supported.

## Before you begin

Install Termux from [GitHub or F-Droid](https://github.com/termux/termux-app#installation). Do not use the deprecated Google Play build.

[Termux:API](https://github.com/termux/termux-api#installation) is optional. Install it only for Android clipboard text or device APIs.

## Install nekcode

1. Update Termux packages:

   ```bash
   pkg update && pkg upgrade
   ```

2. Install Node.js and Git:

   ```bash
   pkg install nodejs git
   ```

3. Install nekcode:

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```

4. Verify the installation:

   ```bash
   nek --version
   ```

5. Start it in the working folder:

   ```bash
   cd /path/to/working-folder
   nek
   ```

Continue with the [Quickstart](quickstart.md#3-choose-a-model) to connect a model and run a task.

## Access Android shared storage

Run this once to grant access:

```bash
termux-setup-storage
```

Shared storage is available under `/storage/emulated/0` and through `~/storage/`. Only grant this permission when nekcode needs those files.

## Use clipboard commands

Install Termux:API and its command-line package:

```bash
pkg install termux-api
```

Verify the integration:

```bash
printf 'nekcode clipboard test' | termux-clipboard-set
termux-clipboard-get
```

The Termux clipboard API supports text only. nekcode's clipboard-paste shortcut cannot attach clipboard images.

## Add Termux-specific instructions

Add relevant environment details to `~/.nek/agent/AGENTS.md`:

````markdown
# Termux environment

- nekcode runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Run `/reload` after changing the file during an active session.

## Troubleshooting

### Clipboard integration fails

Confirm that the Termux:API Android app and the `termux-api` package were installed from the same source as Termux. Test the clipboard commands outside nekcode first.

### Shared storage reports permission denied

Run `termux-setup-storage`, approve the Android permission request, and retry the path under `~/storage/` or `/storage/emulated/0`.

### nekcode is not found after installation

Open a new Termux shell and run:

```bash
npm prefix -g
command -v nek
```

Confirm that the global npm binary directory is on `PATH`, then reinstall the package if necessary.
