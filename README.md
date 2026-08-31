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

The **All Logs** sidebar view records each screen log's byte boundary just
before Start or Restart, then opens a continuous SSH follow stream as soon as
the Screen session exists. It captures startup and later output without polling
a fixed-size tail or loading older history. Streams continue while the view is
hidden and close after a successful Stop.

The displayed combined entries are also saved for the full Andon session in
`~/.afl/logs/combined/`. Each launch creates a separate file whose name
contains Andon's startup timestamp, such as
`andon-2026-08-25_14-03-07-042.log`. Clearing the sidebar does not remove
entries from that file.

When the window is closed from the GUI, Andon asks for confirmation before it
sends the normal stop command to every launcher started or restarted during
that Andon session. The same cleanup runs on `SIGINT`/`SIGTERM`. Launchers
that were already running when Andon opened are not stopped.

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
host) and does not embed driver custom configurations. After a Tiled launcher
passes its health check, Andon appends a record to AFL-automation's global
`~/.afl/config.json` with that launcher's URL and API key. Drivers started later
in the same session therefore use the active Tiled service. The native Tiled
browser may also read the latest `tiled_api_key` from that global file as a
credential fallback when its selected Tiled YAML does not define a key.

When a launcher successfully starts or stops, Andon rewrites its current entry
in the file's `launchers` object with the launcher details, `runtime_state`,
and `started_at` or `stopped_at` timestamp. It does not retain prior snapshots.

If a driver creates a live Screen session but its HTTP health check does not
become ready in time (for example, while it retries an unavailable Tiled
backend), Andon keeps the launch and log stream active. The process indicator
remains active and the HTTP indicator is yellow until the API becomes
reachable; the driver tab remains accessible during this degraded state.

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
3. In AFL-andon, create a **Tiled** launcher, select the copied
   `tiled_config.yml` as its `Config file location`, use a unique screen name,
   set the HTTP port to `8000`, and set `Status URL` to
   `http://<host>:8000/healthz`.
4. Start the launcher from Andon. The server's logs remain available through
   the **View Log** control.

### Tiled browser tab

Select **Tiled** as the server type and set **Config file location** to the
local `tiled_config.yml` file. Choose either the `afl_agent` Conda environment
or a virtualenv (pip/uv); Andon copies that file to a remote host when needed
and launches `tiled serve config <file>`. Clicking this launcher's
existing sidebar tab opens Andon's bundled Tiled database browser in the same
webview. The browser automatically uses the `run_documents` catalog when it is
present (matching the browser served by AFL drivers such as OT2 and RGBCamera)
and otherwise reads the root catalog. The active catalog is shown beside the
connection status. Results are shown in pages of 50 entries; **Next** and
**Previous** follow the Tiled server's cursor links, so browsing continues
through the full catalog. Use the **Columns** menu to choose which data columns
appear in the table; **Select** and **Actions** always remain visible, and the
column choices are saved locally. Filter choices are read from Tiled's
distinct-metadata endpoint; selecting **Data** or **Metadata** on an entry
reads only that entry. These are read-only requests.

For a locally managed profile, Andon reads
`authentication.single_user_api_key`. For an external profile, it reads the
top-level `api_key`. Andon sends the credential only to that launcher's Tiled
API; it is not stored in `launchers.json` or exposed to the browser page. If
the YAML has no key, Andon falls back to the latest `tiled_api_key` in the
local `~/.afl/config.json`.

### External Tiled server profile

Andon distinguishes the two Tiled YAML forms automatically:

- A native service configuration containing `trees` is locally managed. Andon
  can start and stop it with `tiled serve config`.
- A client profile containing `uri` connects to an existing service. Its
  `management` block selects how Andon controls that service.

For example, a Synology-hosted service can use:

```yaml
authentication:
  single_user_api_key: "replace-with-the-server-api-key"
uvicorn:
  host: "0.0.0.0"
  port: 8000
structure_clients: "dask"
management:
  type: "docker_compose"
  authentication: "password"
  host: "192.0.2.10"
  username: "nas-user"
  project_directory: "/srv/tiled-project"
  service: "tiled"
  join_shell: "/bin/sh"
```

This mirrors the authentication and Uvicorn sections in `tiled_local.yml`.
For a NAS profile, Andon derives the public HTTP endpoint from
`management.host` and `uvicorn.port`; the `management` section is the only
additional lifecycle configuration.

Local and NAS-backed Tiled launchers use the same connection summary on the
Andon board: `SSH: username@host, HTTP: host:port`. The selected YAML profile
still determines whether lifecycle management uses Screen or Docker Compose.

Because this YAML contains a credential, keep it out of Git and make it
readable only by the account running Andon (for example, mode `0600`). The
`management` block makes the standard controls operate on the named Docker
Compose service over SSH: Start, Stop, Restart, View Log, and Join respectively
run the Compose lifecycle commands, read service logs, and open `join_shell`
inside the container. The SSH account must accept the selected authentication
method and have permission to run `sudo`. Docker Compose is never invoked as
the login user: Andon opens a root login shell with `sudo -i` and supplies the
same in-memory password over SSH standard input.
When `management.authentication` is `password`, clicking Start prompts for the
SSH password. Andon keeps it only in process memory for subsequent status,
log, and Join connections and discards it when Andon exits. Both SSH password
and keyboard-interactive password login are supported; the latter is commonly
used by Synology DSM even when an interactive `ssh` command simply says
`Password:`.

Before Start runs `docker compose up`, Andon verifies that
`project_directory` exists and that the named `service` is declared by the
Compose project. If that service is already running, Start leaves it untouched.
Missing projects or services are reported as configuration errors and Andon
does not create a replacement deployment.

Use one **Tiled** launcher and select either the local service YAML or the
external client YAML in its **Config file location** field. A native `trees`
profile uses the existing Screen-based controls; an external profile with
`management.type: docker_compose` uses the remote container controls. No
second server type or launcher is needed.

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
