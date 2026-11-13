# Installing AFL Andon

Start with **User installation** to install and run Andon under your own
account. **Developer and administrator setup** follows it and covers preparing
a fresh machine, enabling system services, development, and release builds.

On a shared machine, the SSH service is shared, but SSH keys, authorized keys,
and `~/.afl/` belong to each user separately. A working installation under
another account does not set up your account. Andon requires key authentication
to the current user on `localhost:22`, including when managing local launchers.

- [User installation](#user-installation)
- [Developer and administrator setup](#developer-and-administrator-setup)
- [Troubleshooting](#troubleshooting)

## User installation

These steps run as the account that will use Andon, without sudo. If the
machine lacks system packages or an enabled SSH server, ask an administrator
to complete [Developer and administrator setup](#developer-and-administrator-setup),
then return here. Running npm as root would configure the wrong home directory.

### 1. Check your prerequisites

Use a graphical desktop session: Electron cannot display its window from a
headless SSH session alone. For installation from a source checkout, check:

```text
node --version
npm --version
git --version
ssh -V
```

All commands must succeed. Node.js must be version 20 or newer; use a maintained
LTS release such as 24 on a fresh machine. If you already use nvm, select Node
with `nvm install 24` and `nvm use 24`. To install Node in your own account,
follow [nvm's installation instructions](https://github.com/nvm-sh/nvm#installing-and-updating).
Git, the SSH client/server, and desktop libraries can be installed by an
administrator using the instructions below.

For a trusted desktop build (Linux AppImage, macOS DMG, or Windows NSIS
installer), local Node.js and Git are unnecessary. Complete the SSH key setup
below, install/open that build, and continue with step 4. The built application
performs configuration setup on first launch.

<a id="ssh-key-setup"></a>

### 2. Set up SSH keys for your account

Complete this **before `npm ci`**. This is also the recovery step for
`No readable SSH private key was found for this user account` or the older
`No SSH key or session password is available` installation error.

Andon's file-based authentication requires a readable private key without a
passphrase. An SSH agent holding an encrypted key does not satisfy this check.
Keep existing keys; create a separate key if necessary. Individual launchers
can still use password authentication after installation.

#### Linux and macOS

Run the following in the same terminal as your application user. Use an
existing unencrypted `id_ed25519` key or let the commands create one. If that
filename already holds an encrypted key, change the first line to
`andon_ssh_key="$HOME/.ssh/id_ed25519_andon"` to create a separate key.

```bash
andon_ssh_key="$HOME/.ssh/id_ed25519"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$andon_ssh_key" ]; then
  ssh-keygen -t ed25519 -f "$andon_ssh_key" -N "" -C "afl-andon-local"
fi
chmod 600 "$andon_ssh_key"
if [ ! -f "$andon_ssh_key.pub" ]; then
  ssh-keygen -y -f "$andon_ssh_key" > "$andon_ssh_key.pub"
fi
```

Authorize that public key for **your own account**. These commands preserve
existing authorized keys and avoid adding the same key twice:

```bash
touch "$HOME/.ssh/authorized_keys"
grep -qxF "$(cat "$andon_ssh_key.pub")" "$HOME/.ssh/authorized_keys" || printf '\n%s\n' "$(cat "$andon_ssh_key.pub")" >> "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
export SERVER_CONTROL_SSH_KEY_PATH="$andon_ssh_key"
```

Connect once to verify and accept the local host-key fingerprint. Compare the
fingerprint with the local SSH server's public host key, or ask the machine's
administrator to verify it. Then test login without a password prompt:

```bash
ssh -p 22 -l "$(id -un)" -i "$andon_ssh_key" -o IdentitiesOnly=yes -o ConnectTimeout=5 localhost exit
ssh -p 22 -l "$(id -un)" -i "$andon_ssh_key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 localhost exit
echo $?
```

The last value must be `0`. A connection-refused or timeout error means an
administrator needs to [enable the SSH server](#enable-ssh-server). A
permission-denied error means the key/account setup above needs checking.

Andon detects standard key names such as `id_ed25519` automatically. For a
custom filename, keep `SERVER_CONTROL_SSH_KEY_PATH` set when installing and
running Andon; add its export to your shell's startup file for future terminal
sessions. When opening a desktop build, launch its executable from that
configured terminal, or select the key in Settings once setup is complete.

#### Windows

Run key setup in PowerShell as the account that will run Andon. An
administrator must already have [enabled Windows OpenSSH](#enable-ssh-server).
Use an existing unencrypted key, or create one if none exists:

```powershell
$andonSshKey = "$HOME\.ssh\id_ed25519"
New-Item -ItemType Directory -Force "$HOME\.ssh" | Out-Null
if (-not (Test-Path $andonSshKey)) {
    ssh-keygen -t ed25519 -f $andonSshKey -N '""' -C "afl-andon-local"
}
```

`-N '""'` passes an empty passphrase in Windows PowerShell 5.1. In PowerShell
7.3+ with standard native argument passing, use `-N ''` instead. If the existing
key is encrypted, choose `$andonSshKey = "$HOME\.ssh\id_ed25519_andon"` before
the block to create a separate key. If an existing key lacks a `.pub` file,
recreate the public half:

```powershell
if (-not (Test-Path "$andonSshKey.pub")) {
    ssh-keygen -y -f $andonSshKey | Set-Content -Path "$andonSshKey.pub" -Encoding ascii
}
```

For a **standard user**, authorize the key in your own profile:

```powershell
$authorizedKeys = "$HOME\.ssh\authorized_keys"
$publicKey = (Get-Content "$andonSshKey.pub" -Raw).Trim()
if (-not ((Get-Content $authorizedKeys -ErrorAction SilentlyContinue) -contains $publicKey)) {
    Add-Content -Path $authorizedKeys -Value $publicKey -Encoding ascii
}
icacls.exe $authorizedKeys /inheritance:r /grant "$($env:USERNAME):(F)" /grant "*S-1-5-18:(F)"
$env:SERVER_CONTROL_SSH_KEY_PATH = $andonSshKey
```

If your account belongs to the **Administrators** group, Windows OpenSSH uses
a different authorized-key file. Follow [Windows administrator account keys](#windows-administrator-keys)
instead of the profile authorization block, then return to these login tests.

Accept the verified local host-key fingerprint on the first connection, then
test without a password prompt:

```powershell
ssh -p 22 -l $env:USERNAME -i $andonSshKey -o IdentitiesOnly=yes -o ConnectTimeout=5 localhost exit
ssh -p 22 -l $env:USERNAME -i $andonSshKey -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 localhost exit
$LASTEXITCODE
```

The final value must be `0`. For a custom key filename, set
`$env:SERVER_CONTROL_SSH_KEY_PATH = $andonSshKey` before installation and future
launches, or select the key in Andon's Settings after setup. Microsoft's
[OpenSSH key authentication guide](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)
covers account policies and ACL troubleshooting.

### 3. Install the application

After the SSH login test succeeds, run these commands as your regular user:

```text
git clone https://github.com/usnistgov/AFL-andon.git
cd AFL-andon
npm ci
```

Use your existing checkout if you have one. To install a particular reviewed
branch or release, select it before `npm ci`. Do not use `sudo npm ci`,
`--ignore-scripts`, or `--omit=dev` for a user installation; Electron is an npm
development dependency, and the postinstall hook performs user setup.

The installer authenticates to your account on `localhost:22`, then disconnects
without executing a command or starting a server. Successful setup creates:

```text
~/.afl/
  launchers.json     # {} for a new installation
  configs/
    andon.config.json  # {} initially; server runtime records are saved here
  logs/
```

On Windows, `~` is the current user's home directory, usually
`C:\Users\<username>`. Setup-created directories use mode `0700` and the
configuration files use `0600` on Unix; existing files and permissions are preserved.
Repeating setup does not replace launcher definitions. If
`SERVER_CONTROL_CONFIG_PATH` is set, setup creates or validates that launcher
file and its parent directories instead; the `.afl` config/log directories are
still created. Use an absolute path. A launcher file must contain a JSON object;
use `{}` for an empty installation.

If `npm ci` already downloaded dependencies but failed during SSH setup, finish
[step 2](#ssh-key-setup), then run **from the checkout as the same user**:

```text
npm run setup
```

This retries setup without reinstalling dependencies. If dependency download
itself failed, rerun `npm ci`. Success ends with `AFL Andon setup complete` and
exit status 0. `npm warn deprecated` lines are dependency warnings. A failed
SSH postinstall check means user setup is incomplete; follow its error message.

### 4. Start and verify Andon

From a source checkout, run:

```text
npm start
```

For a desktop build, open the installed application. A first-launch setup
failure displays an error and exits with status 1. Follow the named section
in that error and reopen the application after fixing it.

On a fresh installation, the dashboard should open with **zero server cards**,
Settings should be accessible, and `launchers.json` should contain `{}`.
Andon starts no instrument processes automatically. App logs are written to
`~/.afl/logs/afl-andon.log`, with session logs in `~/.afl/logs/combined/`.

For a custom key/config path, start the desktop executable from a terminal
with the corresponding environment variables set. On macOS the executable is
normally `/Applications/AFL Andon.app/Contents/MacOS/AFL Andon`. On Linux,
make the downloaded AppImage executable with `chmod +x <downloaded-file>.AppImage`.
AppImages may need FUSE 2 (`libfuse2t64` on Ubuntu 24.04+ or `libfuse2` on older
Ubuntu/Debian). The Windows NSIS installer provides a shortcut and executable.

Each managed Unix server host separately needs GNU Screen and the Python
environment that supplies its configured AFL module, script, or Tiled service.
The Windows GUI can manage Unix server hosts; native Windows does not provide
GNU Screen for local Screen-based launchers. The Andon npm install does not
install AFL-automation, AFL-agent, or Python environments. See
[README.md](README.md#configuration-paths) for launcher and Tiled configuration.

## Developer and administrator setup

Use this section to prepare a fresh machine or develop Andon. Sudo or
administrator access is needed for system packages, SSH service changes, and
the Windows administrator authorized-key file. After machine preparation,
return to **User installation** under the intended application account. Key
creation, npm installation, development, and builds run as a regular user.

### 1. Install machine prerequisites

For source installations, provide Git, a supported Node.js LTS release with
npm (minimum Node 20), OpenSSH client/server, and Electron desktop libraries.
Node LTS can be installed from [nodejs.org](https://nodejs.org/en/download) or
with nvm under the application user's account.

#### Ubuntu and Debian

For Ubuntu 24.04+ or Debian 13:

```bash
sudo apt-get update
sudo apt-get install -y git openssh-client openssh-server libgtk-3-0 libnss3 libgbm1 libasound2t64 libxss1
```

On older releases, substitute `libasound2` for `libasound2t64`. Install Node
LTS separately if the distribution's Node package is older than 20. Install
`screen` on this machine if it will host local Screen-based launchers.

#### Fedora and other Linux distributions

```bash
sudo dnf install -y git openssh-clients openssh-server nodejs npm gtk3 nss mesa-libgbm alsa-lib libXScrnSaver
```

Verify the Node version and install a maintained LTS if needed. On other
distributions, install equivalent packages through their package manager.

#### macOS

Install Node LTS and Git, for example using `xcode-select --install` for Apple's
command-line tools. OpenSSH is included with macOS. Enable Remote Login below.

#### Windows 10 and 11

Install Node.js LTS and Git for Windows, using the installers or winget:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Git.Git --exact
```

Reopen PowerShell after installation so the updated PATH is available.

<a id="enable-ssh-server"></a>

### 2. Enable the SSH server

This is the recovery section for connection-refused or timeout errors on
`localhost:22`. A service being enabled is separate from authorizing a key for
each user; finish both before installing Andon.

#### Linux

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
service manager to start OpenSSH and enable it at boot. If loopback connections
time out, check the listener and applicable firewall rules. For remote Tiled
forwarding, the driver host's SSH server must permit remote TCP forwarding.

#### macOS

Open **System Settings > General > Sharing > Remote Login**, enable it, and
allow the account that will run Andon. Older macOS versions use **System
Preferences > Sharing**.

#### Windows OpenSSH

In Administrator PowerShell, install the features and start the service:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd
```

The service must be `Running`. Check that
`Get-NetFirewallRule -Name OpenSSH-Server-In-TCP` reports an enabled rule.
If missing, create it:

```powershell
New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
```

<a id="windows-administrator-keys"></a>

#### Windows administrator account keys

For accounts in the Administrators group, Windows OpenSSH normally reads
`C:\ProgramData\ssh\administrators_authorized_keys` instead of the user's
profile file. After creating a key in the user section, run the following in
elevated PowerShell **for that same account** (adjust the key filename if using
a custom key):

```powershell
$andonSshKey = "$HOME\.ssh\id_ed25519"
$authorizedKeys = "$env:ProgramData\ssh\administrators_authorized_keys"
$publicKey = (Get-Content "$andonSshKey.pub" -Raw).Trim()
if (-not ((Get-Content $authorizedKeys -ErrorAction SilentlyContinue) -contains $publicKey)) {
    Add-Content -Path $authorizedKeys -Value $publicKey -Encoding ascii
}
icacls.exe $authorizedKeys /inheritance:r /grant "*S-1-5-32-544:(F)" /grant "*S-1-5-18:(F)"
```

Return to normal PowerShell for the user-section login tests and npm commands.

### 3. Run in developer mode

Prepare the machine and your own SSH keys as above. In your own checkout,
create a development branch, install dependencies, and open the debugging
build as a regular user:

```bash
git switch -c my-andon-change
npm ci
npm run dev
```

Keep deployment settings and credentials outside the repository. Tests run
with `npm test`; after editing package JSON files, run `npm run check-package`.
Development does not require running Electron or npm with sudo.

### 4. Build desktop releases

After a normal user installation, build your current platform with
`npm run build`; artifacts are written to `dist/`. Platform scripts are
`npm run build:linux`, `npm run build:mac`, and `npm run build:win`.

Release-only dependency installations and CI may set `AFL_ANDON_BUILD_ONLY=1`
to skip user configuration and SSH checks in the **postinstall** hook. Built
apps still perform setup on first launch. This is not a completed user
installation. Explicit `npm run setup` always checks SSH, even with the variable
set. Build as a regular user:

```bash
AFL_ANDON_BUILD_ONLY=1 npm ci
npm run build
```

On Windows PowerShell:

```powershell
$env:AFL_ANDON_BUILD_ONLY = '1'
npm ci
Remove-Item Env:AFL_ANDON_BUILD_ONLY
npm run build
```

## Troubleshooting

| Failure | Where to go |
| --- | --- |
| No readable SSH private key / no SSH key or session password | [User installation: Set up SSH keys for your account](#ssh-key-setup). Another user's keys do not set up this account. |
| Authentication failed / permission denied / encrypted key | [User installation: Set up SSH keys for your account](#ssh-key-setup). Check the key, current username, authorization, and permissions. |
| Connection refused / SSH timeout | [Developer and administrator setup: Enable the SSH server](#enable-ssh-server). |
| Windows administrator key login rejected | [Windows administrator account keys](#windows-administrator-keys). |
| npm deprecation warnings followed by SSH postinstall failure | Fix SSH using the section named by the error, then run `npm run setup` as the same user. |
| Invalid launcher JSON | Preserve and repair the existing file; `{}` is the minimum valid configuration. |
| `EACCES` writing `.afl` | Use the intended account and correct ownership of its configuration directory. |
| Electron missing / missing shared library | Include npm development dependencies and complete [machine prerequisites](#1-install-machine-prerequisites). |
| No display / Electron sandbox error | Start from a normal desktop session as a regular user with OS Electron sandbox facilities enabled. |
