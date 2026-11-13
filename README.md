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

Each server card starts with red **SSH DOWN** and **SERVER DOWN** indicators.

- **Start** launches the server over SSH, resets both indicators to red, and
  then performs a status check. A working SSH connection becomes green **SSH UP**.
  A responding server is green **SERVER ACTIVE**, a paused server is yellow
  **SERVER PAUSED**, and an unreachable server is red **SERVER DOWN**.
- **Stop** sends the stop command for a local launcher. For NAS-managed Tiled,
  it disconnects Andon without changing the remote container and displays
  **SSH DOWN** and **SERVER DOWN**.
- **Restart** resets the indicators to red while it stops and starts the
  server, then performs the same status check as **Start**.

After a successful **Start** or **Restart**, Andon polls only that server for
screen and queue state every 500 ms. Launchers not started by the current
Andon session are not polled, including active external or NAS profiles loaded
from configuration. A failed SSH check displays **SSH DOWN**; an
unreachable HTTP endpoint displays **SERVER DOWN**. Server cards and sidebar
buttons use green for active, yellow for paused, and red for down.
An unavailable queue-state or HTTP health endpoint is logged as a warning and
does not open the error dialog. A live server process whose HTTP endpoint is
not ready after Start or Restart also remains accessible with a warning.
Repeated queue-health warnings are logged once until the endpoint recovers or
the failure reason changes.

Reported errors open a blocking dialog with the affected server and the exact
error text. This includes failed server commands, SSH failures, Andon
application errors, and Python tracebacks or error-level messages in live server
output, including during startup. **Copy Errors** copies all displayed errors
and server names to the clipboard. **Clear Errors** acknowledges them and returns
access to Andon; Escape and clicking outside the dialog do not dismiss it.
Clearing errors retains the combined logs and leaves server processes running.
Repeated polling for the same failure is reported once until it recovers or
changes; new failures open the dialog again.

The **All Logs** sidebar view records each screen log's byte boundary just
before Start or Restart, then opens a continuous SSH follow stream as soon as
the Screen session exists. It captures startup and later output without polling
a fixed-size tail or loading older history. Streams continue while the view is
hidden and close after a successful Stop.

Use the **APIServer** and **QueueDaemon** checkboxes in **All Logs** to show or
hide each module's messages across every server. Both are shown by default.
These controls work together with the server checkboxes and search, and apply
to collected history and incoming output. Re-enabling a module restores its
retained messages; hiding it does not interrupt streaming or saving logs.

The combined view includes both server output and Andon's own application log
messages. These entries are also saved for the full Andon session in
`~/.afl/logs/combined/`. Each launch creates a separate file whose name
contains Andon's startup timestamp, such as
`andon-2026-08-25_14-03-07-042.log`. Clearing the sidebar does not remove
entries from that file. Polled server state is recorded only when it changes;
repetitive successful health-request access lines are omitted, and routine
polling diagnostics remain in `~/.afl/logs/afl-andon.log` at debug level.

When the window is closed from the GUI, Andon asks for confirmation before it
sends the normal stop command to every launcher started or restarted during
that Andon session. NAS-managed Tiled containers are disconnected instead of
stopped. Closing the terminal used to launch Andon also runs the same cleanup,
including when `npm start` or Electron's launch wrapper exits without forwarding
the terminal hangup. Cleanup also runs on `SIGINT`, `SIGTERM`, `SIGHUP`, and
`SIGQUIT`, and repeated signals do not interrupt it. Launchers that were already
running when Andon opened are not stopped.

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

For **Module**, **Script**, and **Tiled** launchers, select **Password** in
the server editor's **SSH Authentication** field to use a password-only SSH account.
Andon prompts before the first operation requiring SSH and reuses that
password for Start, Stop, Restart, status checks, config uploads, logs, and
Join during the session. A rejected password is discarded so the next
operation can prompt again. Passwords remain only in process memory and are
never saved in launcher or runtime configuration files.

The selected mode is stored as `"ssh_authentication": "password"` or
`"ssh_authentication": "key"` in `launchers.json`. This field takes precedence
over a Tiled profile's legacy `management.authentication` setting. Existing
Tiled launchers without this field retain that YAML setting; other launchers
without this field default to SSH keys. Session passwords are shared by
launchers using the same host, username, and SSH port.

To offer common local config files while adding or editing a launcher, add a
top-level `configs_locations` entry to `launchers.json` with a directory path:

```json
{
  "configs_locations": "/path/to/configs",
  "my-server": { "...": "..." }
}
```

When that value is nonempty and the directory exists, Andon shows its files in
the **Config location** menu, alongside **Direct path** for a manually entered
path. Relative directory paths are resolved relative to `launchers.json`.

The Settings tab reads and writes one current configuration file at
`~/.afl/configs/andon.config.json` (or the same path on the selected remote
host) and does not embed driver custom configurations. After a Tiled launcher
passes its health check, Andon appends a record to AFL-automation's global
`~/.afl/config.json` with that launcher's URL and API key. Drivers started later
in the same session automatically receive that connection for both Module
and Script launches. Andon updates the launching account's AFL global config
on its server host before starting the process, preserving other settings and
ports. Remote drivers using HTTP Tiled connect through an SSH tunnel managed
by Andon: the driver connects to a loopback port on its own host, and the
control computer forwards traffic to the selected Tiled service. This works
when the control computer can reach Tiled but the driver host cannot. After
reopening Andon, it discovers a healthy enabled Tiled card, preferring a card
named **tiled**. Before launch, Andon verifies authenticated Tiled access from
the driver's SSH account through the selected endpoint or tunnel. This check
uses `curl` when available and otherwise uses Python 3's standard library.
Failed checks report the HTTP status or connection error. The native Tiled
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
persistent configuration behavior. Andon also passes the launcher's **HTTP
Port** to AFL as `--port`, so the server and Andon's health checks use the same
endpoint.

### Launching a local script on a server

Select **Server Type: Script**, then use **Browse** beside **Server Script**
to select a launcher file on the computer running Andon. You can also paste
its local path into the field. Keep deployment-specific scripts and settings
in a private location outside this repository.

Andon copies the file to the selected SSH account's `~/.afl/scripts/` directory
and runs it in the launcher's Screen session. The file is copied again on
each Start or Restart. Scripts with a shebang use their own interpreter;
files without one use the card's Shell. Existing server-side script commands
remain supported. The script can activate its environment and set its working
directory before starting the server.

Local script paths are saved only as `script_file_location`. The legacy
`server_script` field holds commands that already exist on the server; Andon
removes duplicate script paths when saving the launcher configuration.

The card's **HTTP Port** is passed to Module and Script launches as
`AFL_HTTP_PORT`; Module launches also receive `--port`. AFL's shared launcher uses this value ahead of its saved
`ports` mapping and default port, so scripts that use the AFL launcher need
no separate port setting. The server's AFL-automation installation must
include support for `AFL_HTTP_PORT`. Custom servers can read the same
environment variable when choosing their listening port.

Start Tiled before starting a driver. Andon supplies the current Tiled URL and
API key through the server account's standard AFL global config; scripts do
not need Tiled connection code. For HTTP services, Andon establishes the
tunnel before configuring and starting a remote driver. Local Tiled may
listen only on the control computer's loopback interface; NAS Tiled only
needs to be reachable from the control computer. The driver host's SSH
server must allow remote TCP forwarding. Tunnels share a connection for
drivers using the same SSH account and Tiled service, reconnect on the same
port after an interruption, and close when their last driver stops or Andon
shuts down. Keep Andon running while these drivers send data. HTTPS services
continue to use direct connections from the driver host. Credentials remain
in private runtime configuration.

## Localhost SSH Setup

If a server entry uses `localhost`, AFL Andon still manages it through SSH.
That means the current user must be able to SSH back into the same machine
with the launcher's selected authentication method before start, stop,
restart, and status checks will work. Launchers can use
password authentication as described above. To use SSH keys instead:

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

Select multiple entries and click **Plot Selected** to compare their data in
one plot window. **Overlay compatible datasets** is enabled automatically for
Line 1D, Scatter 2D, and Scatter 3D. Choose a reference dataset under **Axes from
dataset**, then set the shared axis variables and components. Each compatible
entry appears as a separate trace in the legend; click a legend item to hide
or show it. Entries can have different point counts and X coordinates. Labeled
components are matched by value, and entries missing the chosen axes are
reported as skipped. Turn off overlay to view individual entries. Image,
Heatmap, and Contourf plots show the selected entry individually.

For a locally managed profile, Andon reads
`authentication.single_user_api_key`. For an external profile, it reads the
top-level `api_key`. Andon sends the credential only to that launcher's Tiled
API; it is not stored in `launchers.json` or exposed to the browser page. If
the YAML has no key, Andon falls back to the latest `tiled_api_key` in the
local `~/.afl/config.json`.

### External Tiled server profile

To run a local AFL server that connects to an existing Tiled HTTP service, use
a private client YAML in `afl-configs`:

```yaml
uri: "http://<nas-host>:<nas-tiled-port>"
authentication:
  single_user_api_key: "<nas-api-key>"
structure_clients: "dask"
management:
  type: "afl_proxy"
```

Keep the Tiled card's Host and Username set to the computer running the proxy,
choose its virtualenv, select that client YAML as **Config file location**, and
use a free local HTTP port. Andon starts
`python -m AFL.automation.shared.TiledProxyDriver` from that environment through
the existing Screen controls. The proxy driver must be installed from
AFL-automation. The card layout, Start/Stop/Restart, View Log, Join, and bundled
Tiled browser stay the same. The browser reaches the local proxy, which forwards
authenticated requests to the configured NAS. Stopping the card stops only the
local AFL proxy. A client YAML with `uri` and no management block also selects
this mode.

Andon distinguishes the two Tiled YAML forms automatically:

- A native service configuration containing `trees` is locally managed. Andon
  can start and stop it with `tiled serve config`.
- A client profile containing `uri` connects to an existing service. Its
  `management` block selects a local AFL proxy or remote lifecycle management.

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

Select **Password** in the Tiled card's **SSH Authentication** field. Andon
saves `"ssh_authentication": "password"` in `launchers.json`; the YAML's
top-level `authentication` block configures the Tiled HTTP API credential.

Local and NAS-backed Tiled launchers use the same connection summary on the
Andon board: `SSH: username@host, HTTP: host:port`. The selected YAML profile
still determines whether lifecycle management uses Screen or Docker Compose.

Because this YAML contains a credential, keep it out of Git and make it
readable only by the account running Andon (for example, mode `0600`). The
`management` block makes Start and Restart operate on the named Docker Compose
service over SSH, while View Log reads service logs and Join opens `join_shell`
inside the container. Stop only disconnects Andon's status polling, embedded
browser, log stream, and interactive SSH session; it does not stop or alter the
NAS container. The
SSH account must accept the selected authentication
method and have permission to run `sudo`. Docker Compose is never invoked as
the login user: Andon opens a root login shell with `sudo -i` and supplies the
same in-memory password over SSH standard input.
When the card's **SSH Authentication** is **Password**, clicking Start prompts
for the SSH password. Andon keeps it only in process memory for subsequent status,
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
