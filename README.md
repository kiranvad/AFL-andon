# AFL Andon

This Electron application provides a cross‑platform control panel for managing
remote servers.  Each server is defined in a JSON configuration file.  The app
can start, stop and restart screen sessions over SSH, display their current
status and open their web interfaces.  A built‑in terminal allows joining a
running session for interactive commands.

## Features

- Visual dashboard with per‑server status indicators
- Start, stop and restart servers via SSH
- View recent logs and join screen sessions in an integrated terminal
- Add, edit or remove servers stored in `launchers.json`
- Import configuration and SSH key files and set their paths
- Edit local or remote AFL settings using a JSON editor
- Webview tabs for interacting with each server’s web UI
- Optional device server mode for simple up/down checks

## Server Controls

Each server card starts with red **SCREEN DOWN** and **SERVER DOWN** indicators.

- **Start** launches the server over SSH, resets both indicators to red, and
  then performs a status check. A live screen becomes green **SCREEN ACTIVE**;
  a responding HTTP endpoint becomes green **SERVER UP**, **SERVER READY**, or
  **SERVER BUSY**, depending on its queue-state response.
- **Stop** sends the stop command and immediately leaves both indicators red.
- **Restart** resets the indicators to red while it stops and starts the
  server, then performs the same status check as **Start**.

After a successful **Start** or **Restart**, Andon polls only that server for
screen and queue state every 500 ms. Launchers not started by the current
Andon session are not polled. A failed SSH check displays **SSH DOWN**; an
unreachable HTTP endpoint displays **UNREACHABLE**. Detailed HTTP connection
errors are written to the application terminal log rather than the card.

When Andon closes, or receives `SIGINT`/`SIGTERM`, it sends the normal stop
command to every launcher started or restarted during that Andon session.
Launchers that were already running when Andon opened are not stopped.

## Prerequisites

- **Node.js 20** or newer is required. Install via [nvm](https://github.com/nvm-sh/nvm) or your
  preferred method.

## Installation

Install dependencies and audit them for security issues:

```bash
npm install
npm audit fix
```

If additional issues remain after running `npm audit fix`, review the log and
update the affected packages.

## Running

Start the application with:

```bash
npm start
```

For development with debugging enabled use:

```bash
npm run dev
```

## Configuration Paths

By default the app uses `~/.afl/launchers.json` for server definitions and
`~/.ssh/id_rsa` as the SSH key.  These paths can be overridden with the
`SERVER_CONTROL_CONFIG_PATH` and `SERVER_CONTROL_SSH_KEY_PATH` environment
variables or via `--config` and `--ssh-key` command‑line options.  The
Settings tab also provides buttons to change them at runtime.

The Settings tab reads and writes one current configuration file at
`~/.afl/configs/andon.config.json` (or the same path on the selected remote
host). It does not modify AFL-automation's global `~/.afl/config.json` or
embed driver custom configurations.

When a launcher successfully starts or stops, Andon rewrites its current entry
in the file's `launchers` object with the launcher details, `runtime_state`,
and `started_at` or `stopped_at` timestamp. It does not retain prior snapshots.

For a Module launcher, **Config file location** is a path on the computer
running Andon. Andon verifies it before start. For a remote host, Andon copies
the file to `~/.afl/configs/` on that host and starts the module with
`--config` pointing to the copied file. For `localhost`, Andon uses the local
path directly. Leaving the field empty preserves the module's default
persistent configuration behavior.

## Localhost SSH Setup

If a server entry uses `localhost`, AFL Andon still manages it through SSH.
That means the current user must be able to SSH back into the same machine
with a configured private key before start, stop, restart, and status checks
will work.

Add one of your local public keys to `~/.ssh/authorized_keys`:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
grep -qxF "$(cat ~/.ssh/id_ed25519.pub)" ~/.ssh/authorized_keys || cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Then verify that localhost SSH works without a password:

```bash
ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no localhost true
```

If you prefer a different key, either update the command above or point the
application at that key with `SERVER_CONTROL_SSH_KEY_PATH` or the Settings UI.

## Tiled Server

The repository includes a Tiled server configuration and launcher in `tiled/`.
Start it with:

```bash
./tiled/start_tiled.sh
```

The script activates the `afl_agent` Conda environment by default; set
`TILED_CONDA_ENV` to use a different one. The committed configuration contains
no API key and permits anonymous read access. Configure credentials locally if
your deployment requires authenticated writes.

### Configure Tiled for Andon

Keep deployment credentials out of this repository. Copy the `tiled/` folder
to a private runtime location on the machine that will host Tiled, then edit
that copy before starting it through Andon.

1. Edit `start_tiled.sh` to use the correct Conda environment, or set
   `TILED_CONDA_ENV` before running it. Confirm that the script and its
   `tiled_config.yml` are in the intended runtime directory.
2. Edit the copied `tiled_config.yml` if authenticated writes are required.
   Set a local `single_user_api_key` value under `authentication`; do not add
   that value to the repository or to `launchers.json`.
3. In AFL-andon, create a Script launcher that points `Server Script` to the
   copied `start_tiled.sh`. Use a unique screen name, set the HTTP port to
   `8000`, and set `Status URL` to `http://<host>:8000/healthz`.
4. Start the launcher from Andon. The server's logs remain available through
   the **View Log** control.

## Building

Builds for your current platform can be created with:

```bash
npm run build
```

See `package.json` for platform-specific build scripts.
The CI workflow produces installers for each OS:
* macOS: DMG
* Linux: AppImage
* Windows: NSIS exe
