# Installs verified forgebench binaries from Forgebench hosting.
# Usage: irm https://forgebench.ai/install.ps1 | iex
$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 on older builds still negotiates TLS 1.0/1.1 by
# default, which api.github.com refuses outright -- the download fails with a
# connection error that looks like a network outage. Opt in explicitly.
try {
    [Net.ServicePointManager]::SecurityProtocol = `
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# install.sh honours NO_COLOR; this script did not, so the two disagreed about
# the same documented environment variable.
$script:UseColor = -not $env:NO_COLOR

$DownloadBase = if ($env:FORGEBENCH_DOWNLOAD_BASE_URL) { $env:FORGEBENCH_DOWNLOAD_BASE_URL.TrimEnd("/") } else { "https://forgebench.ai/downloads" }
$SetupUrl = if ($env:FORGEBENCH_SETUP_URL) { $env:FORGEBENCH_SETUP_URL } else { "https://api.forgebench.ai" }
$BinName = "forgebench"
$InstallDir = if ($env:FORGEBENCH_INSTALL_DIR) { $env:FORGEBENCH_INSTALL_DIR } else { "$env:LOCALAPPDATA\forgebench" }
# stable (default) = latest non-prerelease. preview = latest develop build.
$Channel = if ($env:FORGEBENCH_CHANNEL) { $env:FORGEBENCH_CHANNEL } else { "stable" }

function Say($msg, $colour) {
    if ($script:UseColor) { Write-Host $msg -ForegroundColor $colour } else { Write-Host $msg }
}
function Info($msg)    { Say "-> $msg" DarkGray }
function Success($msg) { Say "OK $msg" Green }
function Warn($msg)    { Say "!  $msg" Yellow }

function Die($msg) {
    Say "x  error: $msg" Red
    exit 1
}

Write-Host ""
Write-Host "forgebench" -ForegroundColor Cyan -NoNewline
Write-Host " . installer" -ForegroundColor DarkGray

$arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { Die "unsupported CPU architecture (32-bit Windows is not supported)" }
$asset = "$BinName-windows-$arch.exe"
$legacyAsset = "forgebench-session-reviewer-windows-$arch.exe"

Info "Detected windows/$arch -> looking for asset '$asset'"

if ($Channel -notin @("stable", "preview")) { Die "unknown FORGEBENCH_CHANNEL (expected stable or preview)" }
if (-not $DownloadBase.StartsWith("https://")) { Die "FORGEBENCH_DOWNLOAD_BASE_URL must use HTTPS" }
if ($env:FORGEBENCH_RELEASE_TAG) {
    if ($env:FORGEBENCH_RELEASE_TAG -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') { Die "invalid release tag" }
    $metadataUrl = "$DownloadBase/tags/$($env:FORGEBENCH_RELEASE_TAG).json"
} else {
    $metadataUrl = "$DownloadBase/channels/$Channel.json"
}
try { $release = Invoke-RestMethod -Uri $metadataUrl }
catch { Die "could not fetch Forgebench release metadata" }
$tag = $release.tag_name
if ($tag -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or $release.path -notmatch '^releases/[a-zA-Z0-9._-]+/[a-f0-9]{64}$') {
    Die "invalid release metadata"
}
if ($env:FORGEBENCH_RELEASE_TAG -and $tag -ne $env:FORGEBENCH_RELEASE_TAG) { Die "release metadata does not match the requested tag" }
Info "Using $Channel release: $tag"
$releaseBase = "$DownloadBase/$($release.path)"
$downloadUrl = "$releaseBase/$asset"
$checksumsUrl = "$releaseBase/SHA256SUMS"

$tmpDir = Join-Path $env:TEMP ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
    $assetPath = Join-Path $tmpDir $asset
    $checksumsPath = Join-Path $tmpDir "SHA256SUMS"

    Info "Downloading $asset..."
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $assetPath
    } catch {
        $asset = $legacyAsset
        $assetPath = Join-Path $tmpDir $asset
        $downloadUrl = "$releaseBase/$asset"
        Info "Trying legacy asset $asset..."
        try {
            Invoke-WebRequest -Uri $downloadUrl -OutFile $assetPath
        } catch {
            Die "no build for windows/$arch in release $tag (tried both asset names)"
        }
    }

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
    Success "Checksum verified"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $destPath = Join-Path $InstallDir "$BinName.exe"
    Copy-Item -Path $assetPath -Destination $destPath -Force

    Success "Installed $BinName $tag -> $destPath"

    # Read the RAW registry value, not GetEnvironmentVariable: the latter
    # returns the EXPANDED string, and writing that back with
    # SetEnvironmentVariable rewrites a REG_EXPAND_SZ user PATH as REG_SZ --
    # permanently flattening any %USERPROFILE%-style entries the user or their
    # IT department put there. That damage is outside our install and is not
    # undone by uninstalling.
    if ($env:FORGEBENCH_NO_MODIFY_PATH) {
        Info "Not modifying PATH (FORGEBENCH_NO_MODIFY_PATH). Add: $InstallDir"
    } else {
        $key = "HKCU:\Environment"
        $raw = (Get-ItemProperty -Path $key -Name Path -ErrorAction SilentlyContinue).Path
        $kind = "ExpandString"
        try {
            $kind = (Get-Item $key).GetValueKind("Path")
        } catch { $kind = "ExpandString" }
        if ([string]::IsNullOrEmpty($raw)) {
            $newPath = $InstallDir            # a fresh profile: no leading ';'
        } elseif ($raw -split ';' -contains $InstallDir) {
            $newPath = $null
        } else {
            $newPath = "$($raw.TrimEnd(';'));$InstallDir"
        }
        if ($newPath) {
            New-ItemProperty -Path $key -Name Path -Value $newPath -PropertyType $kind -Force | Out-Null
            Success "Added $InstallDir to your user PATH. Restart your terminal for it to take effect."
        }
    }

    Write-Host ""
    $help = (& $destPath --help 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0) {
        Warn "Installed, but '$BinName --help' did not run successfully:"
        Write-Host (($help -split "`n")[0..2] -join "`n")
        Warn "Run '$BinName doctor' once it runs, or reinstall for your platform."
    } elseif ($help -notmatch "(^|[\s\{,])setup([\s\},]|$)") {
        Warn "Release $tag has no guided setup. Use '$BinName login --sso' then '$BinName run --all --push', or install a newer release with setup."
    } else {
        Info "Install complete. Run '$BinName setup --url $SetupUrl' to sign in."
    }
} finally {
    Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}
