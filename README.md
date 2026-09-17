# forgebench-session-reviewer

Installer and release binaries for `forgebench-session-reviewer`, Forgebench's CLI for
local, offline analysis of your AI coding sessions. This repo ships only compiled
binaries (built with Nuitka) and the install scripts below — no application source.

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
forgebench-session-reviewer login --sso
forgebench-session-reviewer run --all --push
```

## Supported platforms

| OS      | Architecture                                     |
| ------- | ------------------------------------------------- |
| macOS   | Apple Silicon (arm64); Intel runs it via Rosetta 2 |
| Linux   | x64                                               |
| Windows | x64                                               |

## Source

The application source lives in the private `forgebench` repository
(`packages/cli-session-reviewer`). This repo only receives compiled release
artifacts from that repo's build pipeline.
