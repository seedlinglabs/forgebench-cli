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
# The installer opens guided setup when the installed release supports it.
forgebench setup
```

Setup signs you in, detects local tools, previews the report and asks before
enabling automatic sync or uploading. Run `forgebench setup` again to change it.
Older releases without `setup` print the manual `login` and `run` commands.

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

## Usage export (OpenTelemetry)

Claude Code and Codex can export exact per-model token and cost counts over
OpenTelemetry. Forgebench turns this on **for the whole organization at once**,
from an admin's managed-settings file — there is no per-developer OTEL command.

### For admins

1. **Create a telemetry key.** In the console, **API Keys** → new key with only
   the `telemetry:ingest` scope. One key serves the whole fleet (identity comes
   from the events, not the key); it can append telemetry and nothing else, so
   it is safe to ship to every laptop. A developer login key is rejected (`403`).
2. **Get the settings snippet.** Console → **Sessions** → details (the rollout
   panel), or `GET /v1/sessions/usage/telemetry/config` (admin only). It returns the Claude Code managed-settings JSON and the Codex
   `[otel]` TOML, pointed at your deployment's
   `https://<api-host>/v1/telemetry/otlp`.
3. **Fill the placeholders.** `<TELEMETRY_KEY>` with the key from step 1.
   `<USER_EMAIL>`, `<HOSTNAME>` and `<TEAM>` with your MDM's per-device
   variables (the response lists the Jamf and Intune equivalents), so one file
   covers the whole fleet. `enduser.id` must be the **work** email — Claude Code
   is often signed into a personal account.
4. **Deploy it with your MDM** as Claude Code's managed settings:
   - macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`
   - Linux: `/etc/claude-code/managed-settings.json`
   - Windows: `C:\Program Files\ClaudeCode\managed-settings.json`

   and the Codex snippet as managed Codex config.
5. **Verify.** `GET /v1/sessions/usage/telemetry/team/status` shows what is
   arriving per developer, and lists unmatched identities to fix.
6. **Cut over.** Once both exporters are live across the fleet and local
   history is imported, set `otel_only_since` (a UTC half-hour boundary) via
   `PATCH /v1/sessions/settings`. From then on spend comes only from OTEL, and
   the CLI stops uploading Claude Code/Codex token counts. Until then both
   routes report and the overlap is only estimated — don't cut over before
   both tools are exporting.

### For developers

Nothing to configure. Install the CLI and run `forgebench setup` as usual.

- Once your admin's managed settings reach your machine, Claude Code and Codex
  export usage by themselves (restart them once to pick it up).
- `forgebench sync` keeps uploading session, branch and work metadata. After
  the cutover it also compares your local totals with what OTEL delivered and
  fills in only sessions OTEL missed.
- `forgebench recover-usage --since 3d` re-runs that recovery by hand.
- To check your export is arriving, use `GET /v1/sessions/usage/telemetry/status`.
  `forgebench status` only reads `~/.claude/settings.json`, so it shows usage
  export as off when it comes from your admin's managed settings.

Want to try it before the fleet rollout? Ask an admin for a `telemetry:ingest`
key and put the same snippet in your own `~/.claude/settings.json` under `env`.

## Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/uninstall.sh | bash
```

This removes hooks, scheduled runs, stored credentials and config, the binary,
and the PATH line added by the installer.

## Supported platforms

| OS | Architecture |
| --- | --- |
| macOS | Apple Silicon arm64; Intel x64 in releases that include the x64 asset |
| Linux | x64 |
| Windows | x64 |

Published assets vary by release. The installer selects an exact architecture match
and reports clearly when an older release lacks that build.

## Source

The application source lives in the private `forgebench` repository
(`packages/cli-session-reviewer`). This repo only receives compiled release
artifacts from that repo's build pipeline.
