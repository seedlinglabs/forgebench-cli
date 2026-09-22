# Removes forgebench: hooks, scheduled run, credentials, config, binary, PATH entry.
# Usage: irm https://raw.githubusercontent.com/seedlinglabs/forgebench-cli/main/uninstall.ps1 | iex
$ErrorActionPreference = "Stop"

$BinName = "forgebench"
$InstallDir = if ($env:FORGEBENCH_INSTALL_DIR) { $env:FORGEBENCH_INSTALL_DIR } else { "$env:LOCALAPPDATA\forgebench" }
$UseColor = -not $env:NO_COLOR

function Say($msg, $colour) {
    if ($UseColor) { Write-Host $msg -ForegroundColor $colour } else { Write-Host $msg }
}
function Info($msg)    { Say "-> $msg" DarkGray }
function Success($msg) { Say "OK $msg" Green }
function Warn($msg)    { Say "!  $msg" Yellow }

Write-Host ""
Say "forgebench . uninstaller" Cyan

# Let the CLI remove what only it knows about first: its hooks live inside
# OTHER tools' config files, and deleting those files wholesale would take the
# user's own hooks with them.
$destPath = Join-Path $InstallDir "$BinName.exe"
if (Test-Path $destPath) {
    Info "Removing hooks, schedule and stored credentials..."
    & $destPath uninstall
    if ($LASTEXITCODE -ne 0) { Warn "The CLI reported a problem; continuing." }
    Remove-Item -Force $destPath -ErrorAction SilentlyContinue
    Success "Removed $destPath"
} else {
    Warn "No $BinName.exe found in $InstallDir; removing the PATH entry only."
}

# Same REG_EXPAND_SZ care as the installer: read the RAW value and write back
# the same kind, so a %USERPROFILE%-style PATH is not flattened on the way out.
$key = "HKCU:\Environment"
$raw = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path
if ($raw) {
    $kind = "ExpandString"
    try { $kind = (Get-Item $key).GetValueKind("Path") } catch { $kind = "ExpandString" }
    $kept = ($raw -split ';') | Where-Object { $_ -and $_ -ne $InstallDir }
    $newPath = ($kept -join ';')
    if ($newPath -ne $raw) {
        New-ItemProperty -Path $key -Name Path -Value $newPath -PropertyType $kind -Force | Out-Null
        Success "Removed $InstallDir from your user PATH."
    }
}

if (Test-Path $InstallDir) {
    if (-not (Get-ChildItem -Path $InstallDir -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -Force $InstallDir -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Say "forgebench has been removed." Green
