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

## Usage

```sh
# The installer opens guided setup after installation.
forgebench setup
```

Setup signs the developer in, detects supported local tools, previews the exact
report locally, and asks whether to enable automatic sync and upload. Nothing
is uploaded until you say so. For an already installed CLI, rerun `setup`.

If something is not working, `forgebench doctor` diagnoses it and prints the
fix; `forgebench status` shows what is configured.

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

The fleet entry point is therefore:

```sh
curl -fsSL .../install.sh | bash -s -- --yes --no-modify-path --no-setup
```

Behind a proxy or a TLS-inspecting middlebox, set `HTTPS_PROXY` and, if your
org re-signs TLS, `SSL_CERT_FILE` (or `FORGEBENCH_CA_BUNDLE` for the CLI
itself). The installer reports proxy, DNS and TLS failures distinctly rather
than as a missing release.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/uninstall.sh | bash
```

This removes the session-end hooks, the scheduled run, stored credentials and
config, the binary, and the PATH line the installer added.

## Supported platforms

| OS      | Architecture                                        |
| ------- | --------------------------------------------------- |
| macOS   | Apple Silicon (arm64); Intel (x64) via Rosetta 2     |
| Linux   | x64                                                 |
| Windows | x64                                                 |

Only `darwin-arm64`, `linux-x64` and `windows-x64` binaries are published.
On an Intel Mac the installer falls back to the arm64 build, which runs under
Rosetta 2. There is no `linux-arm64` build yet; the installer says so rather
than failing on a missing asset.

## Source

The application source lives in the private `forgebench` repository
(`packages/cli-session-reviewer`). This repo only receives compiled release
artifacts from that repo's build pipeline.
