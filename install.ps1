# Installs forgebench-session-reviewer from this repo's GitHub Releases.
# Usage: irm https://raw.githubusercontent.com/<org>/<repo>/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = "seedlinglabs/forgebench-cli"
$BinName = "forgebench-session-reviewer"
$InstallDir = if ($env:FORGEBENCH_INSTALL_DIR) { $env:FORGEBENCH_INSTALL_DIR } else { "$env:LOCALAPPDATA\forgebench-session-reviewer" }
# stable (default) = latest non-prerelease. preview = latest develop build.
$Channel = if ($env:FORGEBENCH_CHANNEL) { $env:FORGEBENCH_CHANNEL } else { "stable" }

function Die($msg) {
    Write-Error "error: $msg"
    exit 1
}

$arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { Die "unsupported CPU architecture (32-bit Windows is not supported)" }
$asset = "$BinName-windows-$arch.exe"

Write-Host "Detected windows/$arch -> looking for asset '$asset'"

if ($Channel -eq "stable") {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    } catch {
        Die "could not reach GitHub releases API for $Repo"
    }
    $tag = $release.tag_name
} elseif ($Channel -eq "preview") {
    try {
        # /releases/latest ignores prereleases by design, so the newest
        # preview build has to come from the full list instead (newest-first).
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases"
    } catch {
        Die "could not reach GitHub releases API for $Repo"
    }
    $tag = ($releases | Where-Object { $_.prerelease } | Select-Object -First 1).tag_name
} else {
    Die "unknown FORGEBENCH_CHANNEL '$Channel' (expected 'stable' or 'preview')"
}

if (-not $tag) { Die "could not determine the $Channel release tag" }
Write-Host "Using $Channel release: $tag"

$downloadUrl = "https://github.com/$Repo/releases/download/$tag/$asset"
$checksumsUrl = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS"

$tmpDir = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
    $assetPath = Join-Path $tmpDir $asset
    $checksumsPath = Join-Path $tmpDir "SHA256SUMS"

    Write-Host "Downloading $asset..."
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $assetPath
    } catch {
        Die "no build for windows/$arch in release $tag (expected $downloadUrl)"
    }

    Write-Host "Verifying checksum..."
    try {
        Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath
    } catch {
        Die "could not fetch SHA256SUMS for release $tag"
    }

    $line = Select-String -Path $checksumsPath -Pattern "  $asset$|\*$asset$" | Select-Object -First 1
    if (-not $line) { Die "no checksum entry for $asset in SHA256SUMS" }
    $expected = ($line.Line -split '\s+')[0]

    $actual = (Get-FileHash -Path $assetPath -Algorithm SHA256).Hash.ToLower()
    if ($expected.ToLower() -ne $actual) {
        Die "checksum mismatch for $asset (expected $expected, got $actual) -- refusing to install"
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $destPath = Join-Path $InstallDir "$BinName.exe"
    Copy-Item -Path $assetPath -Destination $destPath -Force

    Write-Host "Installed $BinName $tag to $destPath"

    $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$InstallDir*") {
        [System.Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
        Write-Host ""
        Write-Host "Added $InstallDir to your user PATH. Restart your terminal for it to take effect."
    }

    Write-Host ""
    Write-Host "Run '$BinName login --sso' to get started."
} finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
