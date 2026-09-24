# forgebench

Installer and release binaries for `forgebench`, Forgebench's CLI for
local, offline analysis of your AI coding sessions (the Session Reviewer).
This repo ships only compiled binaries (built with Nuitka) and the install
scripts below — no application source.

## Install

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/install.ps1 | iex
```

Both scripts detect your OS/CPU, download the matching binary from this repo's
[Releases](../../releases), verify its checksum against the published `SHA256SUMS`,
and install it to a user-writable directory (no admin/sudo required).

By default you get the latest **stable** release. To try the newest **preview**
build (from `develop`, ahead of the next stable release) instead:

```sh
curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/install.sh | FORGEBENCH_CHANNEL=preview bash
```

```powershell
$env:FORGEBENCH_CHANNEL = "preview"; irm https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/install.ps1 | iex
```

## Usage

```sh
# The installer opens guided setup after installation.
forgebench setup
```

Setup signs you in, detects local tools, previews the report and asks before
enabling automatic sync or uploading. Run `forgebench setup` again to change it.

```sh
forgebench --version
forgebench update              # checks stable
forgebench update --channel preview
forgebench status              # login, hooks and schedule
forgebench doctor              # diagnose setup problems
```

`update` prints the exact install command; it does not replace a running binary.

### Installer options

```sh
curl -fsSL .../install.sh | bash -s -- --help
```

| Flag | Env | Meaning |
| --- | --- | --- |
| `--version <tag>` | `FORGEBENCH_RELEASE_TAG` | install an exact release |
| `--install-dir <dir>` | `FORGEBENCH_INSTALL_DIR` | where the binary goes |
| `--no-modify-path` | `FORGEBENCH_NO_MODIFY_PATH` | never edit a shell profile |
| `--no-setup` | `FORGEBENCH_NO_SETUP` | install only |
| `--yes` | `FORGEBENCH_YES` | assume yes for prompts |

For a fleet install:

```sh
curl -fsSL .../install.sh | bash -s -- --yes --no-modify-path --no-setup
```

Behind a proxy or TLS inspection, set `HTTPS_PROXY` and your corporate CA
(`SSL_CERT_FILE`, or `FORGEBENCH_CA_BUNDLE` for the CLI).

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/uninstall.sh | bash
```

This removes hooks, scheduled runs, stored credentials and config, the binary,
and the PATH line added by the installer.

## Supported platforms

| OS | Architecture |
| --- | --- |
| macOS | arm64; Intel x64 via Rosetta 2 |
| Linux | x64 |
| Windows | x64 |

Only `darwin-arm64`, `linux-x64` and `windows-x64` binaries are published.

## Source

The application source lives in the private `forgebench` repository
(`packages/cli-session-reviewer`). This repo only receives compiled release
artifacts from that repo's build pipeline.
