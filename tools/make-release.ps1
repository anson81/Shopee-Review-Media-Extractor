<#
    Kept so the old command still works on Windows and macOS. The release logic
    lives in tools/make-release.js, which runs anywhere Node does (including the
    Linux P50, which has no PowerShell). Prefer calling that directly:

        node tools/make-release.js 1.2.0 "Fixed X" "Added Y"

    Usage here, unchanged:
        .\tools\make-release.ps1 -Version 1.2.0 -Notes "Fixed X","Added Y"
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string[]]$Notes = @()
)

& node (Join-Path $PSScriptRoot 'make-release.js') $Version @Notes
exit $LASTEXITCODE
