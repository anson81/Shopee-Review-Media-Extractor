<#
    Bumps the version and regenerates update.json from what is actually on disk,
    so the file list can never drift out of sync with the extension.

    Usage:
        .\tools\make-release.ps1 -Version 1.1.0 -Notes "Fixed X","Added Y"

    Then commit and push. The extension checks update.json on the default
    branch and offers the new version. An unpushed release is invisible to it.
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string[]]$Notes = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 1.2.0 (got '$Version')."
}

# --- run the tests before shipping anything ---------------------------------
# A release is the worst time to find out the ZIP writer is broken, and these
# take a couple of seconds.
Write-Host 'Running tests...'
foreach ($test in @('test-zip.js', 'test-csv.js', 'test-naming.js', 'test-api.js', 'test-no-filename-listener.js', 'test-db-version.js')) {
    $testPath = Join-Path $PSScriptRoot $test
    & node $testPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$test failed - fix it before releasing." }
    Write-Host "  ok  $test"
}

# --- update manifest.json ---------------------------------------------------
# Edited as text, not round-tripped through ConvertTo-Json: that reformats the
# whole file and can collapse single-element arrays, which would quietly break
# the manifest.
$manifestPath = Join-Path $root 'manifest.json'
$raw = [System.IO.File]::ReadAllText($manifestPath)
$pattern = '(?m)^(\s*"version"\s*:\s*)"[^"]*"'
if ($raw -notmatch $pattern) { throw 'Could not find a "version" line in manifest.json.' }
$old = ([regex]::Match($raw, '"version"\s*:\s*"([^"]*)"')).Groups[1].Value
if ($old -eq $Version) {
    throw "manifest.json is already at $Version. Never ship changes on an unchanged version number."
}
$raw = [regex]::Replace($raw, $pattern, "`${1}""$Version""", 1)
[System.IO.File]::WriteAllText($manifestPath, $raw, (New-Object System.Text.UTF8Encoding $false))

# Prove we did not corrupt it.
$check = Get-Content $manifestPath -Raw | ConvertFrom-Json
if ($check.version -ne $Version) { throw 'manifest.json version did not take.' }
if (-not $check.content_scripts -or $check.content_scripts.Count -lt 2) {
    throw 'manifest.json lost a content script - restore it from git.'
}
if (-not $check.host_permissions -or $check.host_permissions.Count -lt 5) {
    throw 'manifest.json lost host permissions - restore it from git.'
}
if (-not $check.background.service_worker) {
    throw 'manifest.json lost the service worker - restore it from git.'
}
Write-Host "manifest.json: $old -> $Version"

# --- collect the files that make up the extension ---------------------------
# Only what Chrome actually loads. Repo plumbing and docs are not part of the
# extension, and listing them would have the updater download files that do
# nothing - or 404 for anyone who cloned without them.
$skip = @('tools', 'docs', '.git', '.github', 'node_modules')
$files = Get-ChildItem -Path $root -Recurse -File |
    Where-Object {
        $rel = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
        $top = $rel.Split('/')[0]
        ($skip -notcontains $top) -and -not $rel.Split('/')[-1].StartsWith('.')
    } |
    ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') } |
    Sort-Object

# Everything the manifest names must be in that list, or the updater ships a
# version that cannot load.
$required = @('manifest.json', $check.background.service_worker)
$required += $check.content_scripts | ForEach-Object { $_.js } | Where-Object { $_ }
$required += $check.content_scripts | ForEach-Object { $_.css } | Where-Object { $_ }
foreach ($needed in ($required | Select-Object -Unique)) {
    if ($files -notcontains $needed) {
        throw "manifest.json references '$needed' but it is not on disk."
    }
}

# --- write update.json ------------------------------------------------------
$updatePath = Join-Path $root 'update.json'
$json = [ordered]@{
    version = $Version
    notes   = @($Notes)
    files   = @($files)
} | ConvertTo-Json -Depth 20
# ConvertTo-Json collapses a one-element array to a scalar; the updater needs
# real arrays.
if ($Notes.Count -eq 1) { $json = $json -replace '("notes"\s*:\s*)("(?:[^"\\]|\\.)*")', '$1[$2]' }
[System.IO.File]::WriteAllText($updatePath, $json, (New-Object System.Text.UTF8Encoding $false))

$verify = Get-Content $updatePath -Raw | ConvertFrom-Json
if (@($verify.files).Count -ne $files.Count) { throw 'update.json file list did not round-trip.' }

Write-Host "update.json lists $($files.Count) files:"
$files | ForEach-Object { Write-Host "  $_" }
Write-Host ''
Write-Host "Now: git add -A; git commit -m 'v$Version'; git push"
