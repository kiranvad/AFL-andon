# Installing AFL Andon

This guide installs the Electron control application on a fresh Linux, macOS,
or Windows desktop. Run the application and its npm commands as the account
that will use Andon. Administrator privileges are needed only for operating
system packages, SSH service setup, and the Windows administrator key file.

Andon manages even local launchers through SSH. Installation therefore requires
an SSH server listening on `localhost:22` and a successful key login to the
current account. Installing an SSH client alone is insufficient. Setup uses
Andon's own SSH library to authenticate and then disconnects without executing
a command or starting a server. Individual launchers may subsequently use
password authentication.

## 1. Choose an installation method

The source installation below is the recommended reproducible path for users
and coding agents. It uses the committed npm lockfile. A graphical desktop is
required to open Andon; a headless SSH session alone cannot display Electron.

If you already have a trusted platform build (Linux AppImage, macOS DMG, or
Windows NSIS installer), complete the SSH steps below, install/open the build,
and follow step 5. Those builds need no local Node.js or Git: they perform user
setup on first launch. A first-launch setup failure displays an error and exits
with status 1; fix the reported problem and open the app again. Source
installations run setup during `npm ci` or `npm install`.

## 2. Install system prerequisites

For a source installation, install Git and a supported Node.js LTS release
with npm from [nodejs.org](https://nodejs.org/en/download). Node.js must be
version 20 or newer; use a maintained LTS release such as 24 on a fresh machine.
Do not omit npm development dependencies: Electron is installed as one.

### Ubuntu / Debian

Install Git, the SSH client/server, and Electron's desktop libraries. For
Ubuntu 24.04+ or Debian 13:

```bash
sudo apt-get update
sudo apt-get install -y git openssh-client openssh-server libgtk-3-0 libnss3 libgbm1 libasound2t64 libxss1
```

On older releases that provide `libasound2` instead of `libasound2t64`, substitute
that package name. Install Node.js LTS separately if the distribution's Node.js
package is older than 20. If Node is managed with nvm, install a maintained LTS
with `nvm install 24` and select it with `nvm use 24`.

### Fedora

```bash
sudo dnf install -y git openssh-clients openssh-server nodejs npm gtk3 nss mesa-libgbm alsa-lib libXScrnSaver
```

Check the installed Node version below; use Node.js LTS if the distribution
provides an older version. For other Linux distributions, install the
equivalent OpenSSH server/client and Electron runtime libraries using the
distribution's package manager.

### macOS

Install the Node.js LTS macOS installer and Git (for example, using
`xcode-select --install` to install Apple's command-line tools). OpenSSH is
included with macOS. Enable Remote Login in step 3.

### Windows 10 / 11

Install Node.js LTS and Git for Windows. If `winget` is available, run:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Git.Git --exact
```

Close and reopen PowerShell so the updated PATH is available. Install and
enable Windows OpenSSH in step 3. The Windows GUI can manage Linux/macOS server
hosts; Screen-based Module, Script, and Tiled launches require a Unix-like
server host with GNU Screen. Native Windows does not provide GNU Screen.

### Verify the tools

In a new terminal (PowerShell on Windows), run:

```text
node --version
npm --version
git --version
ssh -V
```

All four commands must succeed; Node must report version 20 or higher.
For a desktop build, only the SSH commands are required.

## 3. Enable and test localhost SSH

Do this before running `npm ci`. Setup never enables system services or creates
SSH keys automatically. Andon's file-based key authentication currently
requires a readable private key without a passphrase; an SSH agent holding an
encrypted key does not satisfy the installation check. Restrict the key's
permissions as shown below.

### Linux

On Ubuntu/Debian with systemd:

```bash
sudo systemctl enable --now ssh
systemctl is-active ssh
```

On Fedora and distributions that name the service `sshd`:

```bash
sudo systemctl enable --now sshd
systemctl is-active sshd
```

The status must be `active`. On systems without systemd, use the system's
service manager to start OpenSSH and enable it at boot. Continue with the
Linux/macOS key steps below.

### macOS

Open **System Settings → General → Sharing → Remote Login**, turn it on, and
allow the account that will run Andon. On older macOS versions, this is in
**System Preferences → Sharing**. Continue with the key steps below.

### Authorize a key on Linux / macOS

As the account that will run Andon, use an existing unencrypted key or create
one if `id_ed25519` does not already exist:

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$HOME/.ssh/id_ed25519" ]; then
  ssh-keygen -t ed25519 -f "$HOME/.ssh/id_ed25519" -N "" -C "afl-andon-local"
fi
```

If that existing key has a passphrase, create a separate key named
`id_ed25519_andon` instead and set
`export SERVER_CONTROL_SSH_KEY_PATH="$HOME/.ssh/id_ed25519_andon"`.
Substitute that filename in the following commands. Never overwrite an
existing private key.

```bash
touch "$HOME/.ssh/authorized_keys"
grep -qxF "$(cat "$HOME/.ssh/id_ed25519.pub")" "$HOME/.ssh/authorized_keys" || cat "$HOME/.ssh/id_ed25519.pub" >> "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/id_ed25519" "$HOME/.ssh/authorized_keys"
ssh -i "$HOME/.ssh/id_ed25519" -o IdentitiesOnly=yes localhost exit
```

On the first login, verify and accept the local host-key fingerprint. Then
verify login without any password or host-key prompt:

```bash
ssh -i "$HOME/.ssh/id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 localhost exit
```

The command must exit with status 0 (`echo $?`). Keep any
`SERVER_CONTROL_SSH_KEY_PATH` override in the environment used to install and
run Andon. For repeated terminal launches, add the export to your shell's
startup file. Andon also searches standard key names in `~/.ssh/`, preferring
Ed25519 keys when no explicit path is supplied.

### Windows OpenSSH service and keys

In **Administrator PowerShell**, install the OpenSSH features and enable the
service (already-installed features can be left in place):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd
```

The service must be `Running`. Windows normally adds the OpenSSH firewall rule
with the server feature. Confirm it is enabled with
`Get-NetFirewallRule -Name OpenSSH-Server-In-TCP`; if missing, create it:

```powershell
New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

As the account that will run Andon, create a key only if none exists:

```powershell
New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
if (-not (Test-Path "$HOME\.ssh\id_ed25519")) {
    ssh-keygen -t ed25519 -f "$HOME\.ssh\id_ed25519" -N '""' -C "afl-andon-local"
}
```

The `-N '""'` spelling passes an empty passphrase in Windows PowerShell 5.1.
In PowerShell 7.3+ with standard native argument passing, use `-N ''` instead.
If the existing key is encrypted, create a separate unencrypted
`id_ed25519_andon` key and set
`$env:SERVER_CONTROL_SSH_KEY_PATH = "$HOME\.ssh\id_ed25519_andon"` before
installation and each launch; substitute its name below.

For a **standard user**, authorize the public key in that user's profile:

```powershell
$authorizedKeys = "$HOME\.ssh\authorized_keys"
$publicKey = (Get-Content "$HOME\.ssh\id_ed25519.pub" -Raw).Trim()
if (-not ((Get-Content $authorizedKeys -ErrorAction SilentlyContinue) -contains $publicKey)) {
    Add-Content -Path $authorizedKeys -Value $publicKey -Encoding ascii
}
icacls.exe $authorizedKeys /inheritance:r /grant "$($env:USERNAME):(F)" /grant "*S-1-5-18:(F)"
```

For an account in the **Administrators** group, the default Windows OpenSSH
configuration reads `C:\ProgramData\ssh\administrators_authorized_keys`
instead. In elevated PowerShell for the same account, use the same public-key
append commands with
`$authorizedKeys = "$env:ProgramData\ssh\administrators_authorized_keys"`,
then restrict that file's permissions:

```powershell
icacls.exe $authorizedKeys /inheritance:r /grant "*S-1-5-32-544:(F)" /grant "*S-1-5-18:(F)"
```

Verify login from a normal PowerShell terminal, accepting the verified local
host-key fingerprint on the first connection:

```powershell
ssh -i "$HOME\.ssh\id_ed25519" -o IdentitiesOnly=yes "$env:USERNAME@localhost" exit
ssh -i "$HOME\.ssh\id_ed25519" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 "$env:USERNAME@localhost" exit
$LASTEXITCODE
```

The final value must be `0`. See Microsoft's
[OpenSSH key authentication guide](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)
if account policies or ACLs prevent login.

## 4. Install Andon from source

In a normal terminal as the application user, choose a working directory and
run (the commands also work in PowerShell):

```text
git clone https://github.com/usnistgov/AFL-andon.git
cd AFL-andon
npm ci
```

For a specific reviewed branch or release, check it out before `npm ci`.
If you already have the checkout, use it rather than cloning another copy.
Do not use `sudo npm ci`, `--ignore-scripts`, or `--omit=dev` for a user install.

The postinstall step authenticates to the current account on `localhost:22`.
If successful, it creates:

```text
~/.afl/
  launchers.json     # {} on a new installation
  configs/
  logs/
```

On Windows, `~` is the current user's home directory, usually
`C:\Users\<username>`. Newly created directories use mode `0700` and the
launcher file uses `0600` on Unix. Existing files and their permissions are
preserved. Repeating setup is safe and does not replace launcher definitions.

If `SERVER_CONTROL_CONFIG_PATH` is set, setup creates or validates the launcher
file at that path and creates its parent directories; `~/.afl/configs/` and
`~/.afl/logs/` are still created. Use an absolute path. Existing launcher files
must contain a JSON object; an empty or malformed text file is an error. Use
`{}` to intentionally start with no launchers.

If installation fails, resolve the reported issue and rerun:

```text
npm run setup
```

This reruns the SSH check and configuration setup without reinstalling the
dependencies. If dependency download itself failed, rerun `npm ci` instead.
Success ends with `AFL Andon setup complete` and exit status 0. Do not treat a
failed postinstall as a completed installation or rewrite existing configs
to hide a failure.

## 5. Start and verify the application

From the source checkout:

```text
npm start
```

For a desktop build, open the installed app. Launch it from a terminal with
the configured environment if you use a custom SSH key/config path. On macOS,
the executable is normally
`/Applications/AFL Andon.app/Contents/MacOS/AFL Andon`; on Linux, execute the
AppImage after `chmod +x <downloaded-file>.AppImage`. AppImages may require
the distribution's FUSE 2 package (`libfuse2t64` on Ubuntu 24.04+,
`libfuse2` on older Ubuntu/Debian). The NSIS installer provides a Windows
shortcut and application executable.

For a fresh installation, verify that the dashboard opens with **zero server
cards**, Settings is accessible, and `launchers.json` contains `{}`. Andon
does not start any instrument server automatically. Add launchers through the
GUI only after their server environments are ready. App logs are written to
`~/.afl/logs/afl-andon.log`, with session logs under `~/.afl/logs/combined/`.

Each managed Unix server host needs an SSH account with the chosen
authentication method, GNU Screen (`screen --version`), and the environment
that supplies the configured Python module, script, or Tiled service. Install
those separately on the host that runs them; the Andon npm installation does
not install AFL-automation, AFL-agent, or Python environments. For forwarded
Tiled connections, that host's SSH server must permit remote TCP forwarding.
See [README.md](README.md#configuration-paths) for launcher configuration and
Tiled setup.

## Troubleshooting

| Failure | Action |
| --- | --- |
| `SSH setup check failed` / connection refused | Enable the local OpenSSH server or macOS Remote Login; verify it listens on port 22. |
| SSH timeout | Check service status, loopback connectivity, and the SSH firewall rule. |
| `No SSH key or session password is available` | Create/authorize an unencrypted key, or set `SERVER_CONTROL_SSH_KEY_PATH` to one. |
| Authentication failed / permission denied | Verify the username, authorized public key, private-key readability, and authorized-key permissions. On Windows check the administrator key-file rule. |
| Cannot parse private key / encrypted key | Select an unencrypted supported key; Andon does not unlock passphrase-protected files during setup. |
| Cannot read launcher configuration / invalid JSON object | Repair the existing file while preserving its definitions; `{}` is the minimal valid file. |
| `EACCES` writing `.afl` | Run as the intended user and correct ownership of their configuration directory. |
| Electron missing or missing shared library | Install npm development dependencies and the operating system desktop libraries from step 2. |
| No display / Electron sandbox error | Launch from a normal desktop session as a regular user with the OS Electron sandbox facilities enabled. |

## Building releases without configuring the build machine

Only dependency installs used to produce release artifacts may set
`AFL_ANDON_BUILD_ONLY=1`. This skips user setup in the npm **postinstall** hook;
the built app still performs setup on first launch. CI uses this mode because
its runners are build hosts, not Andon installations. It is not a successful
user installation. Explicit `npm run setup` always checks SSH, even with the
build-only variable set.

Linux/macOS:

```bash
AFL_ANDON_BUILD_ONLY=1 npm ci
npm run build
```

Windows PowerShell:

```powershell
$env:AFL_ANDON_BUILD_ONLY = '1'
npm ci
Remove-Item Env:AFL_ANDON_BUILD_ONLY
npm run build
```
