#Requires -Version 5.1
<#
.SYNOPSIS
Run the isolated Jev research CLI. The default mode is offline status.
.EXAMPLE
.\scripts\Invoke-Jev.ps1 -Mode demo
.EXAMPLE
.\scripts\Invoke-Jev.ps1 -Mode live -MaxRequests 3
#>
[CmdletBinding()]
param(
    [ValidateSet('status', 'demo', 'probe', 'live', 'watch')]
    [string]$Mode = 'status',

    [ValidateRange(1, 1000)]
    [int]$MaxRequests,

    [ValidateNotNullOrEmpty()]
    [string]$NewsDirectory = 'data/news',

    [ValidateNotNullOrEmpty()]
    [string]$Directory = 'data/jev',

    [ValidateNotNullOrEmpty()]
    [string]$EvidenceFile,

    [ValidateRange(1, 1000)]
    [int]$MaxEvents = 20,

    [ValidateRange(1, 44640)]
    [int]$MaxAgeMinutes = 1440,

    [ValidateRange(1, 480)]
    [int]$DurationMinutes,

    [ValidateNotNullOrEmpty()]
    [string]$Sources,

    [ValidateRange(1, 60)]
    [int]$PollSeconds = 1,

    [ValidateRange(1, 600)]
    [int]$HealthMaxAgeSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$usesApi = $Mode -in @('live', 'probe', 'watch')
if ($usesApi -and -not $PSBoundParameters.ContainsKey('MaxRequests')) {
    throw 'Live, probe and watch modes require an explicit positive -MaxRequests limit.'
}
if (-not $usesApi -and $PSBoundParameters.ContainsKey('MaxRequests')) {
    throw '-MaxRequests is only accepted in live, probe or watch mode.'
}
if ($Mode -eq 'probe' -and $MaxRequests -ne 1) { throw 'Probe mode requires -MaxRequests 1.' }
if ($Mode -eq 'watch') {
    foreach ($required in @('DurationMinutes', 'Sources', 'Directory')) {
        if (-not $PSBoundParameters.ContainsKey($required)) { throw ('Watch mode requires explicit -' + $required + '.') }
    }
    if ($PSBoundParameters.ContainsKey('EvidenceFile')) { throw 'Watch mode does not accept a static evidence file.' }
    if ($Sources -notmatch '^(yahoo|sec|x|benzinga|primary)(,(yahoo|sec|x|benzinga|primary))*$') { throw 'Invalid watch source list.' }
    if (-not $PSBoundParameters.ContainsKey('MaxAgeMinutes')) { $MaxAgeMinutes = 5 }
    if ($MaxAgeMinutes -gt 30) { throw 'Watch source publication age cannot exceed 30 minutes.' }
} else {
    foreach ($watchOnly in @('DurationMinutes', 'Sources', 'PollSeconds', 'HealthMaxAgeSeconds')) {
        if ($PSBoundParameters.ContainsKey($watchOnly)) { throw ('-' + $watchOnly + ' requires watch mode.') }
    }
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cliPath = Join-Path $repoRoot 'src/research/jev/jev-cli.ts'
if (-not [IO.File]::Exists($cliPath)) {
    throw 'The Jev research CLI is missing from this checkout.'
}
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$cliArguments = @('--import', 'tsx', $cliPath, ('--' + $Mode),
    '--news-directory', $NewsDirectory, '--directory', $Directory,
    '--max-events', $MaxEvents.ToString(), '--max-age-minutes', $MaxAgeMinutes.ToString())
if ($usesApi) { $cliArguments += @('--max-requests', $MaxRequests.ToString()) }
if ($PSBoundParameters.ContainsKey('EvidenceFile')) { $cliArguments += @('--evidence-file', $EvidenceFile) }
if ($Mode -eq 'watch') {
    $cliArguments += @('--duration-minutes', $DurationMinutes.ToString(), '--sources', $Sources,
        '--poll-seconds', $PollSeconds.ToString(), '--health-max-age-seconds', $HealthMaxAgeSeconds.ToString())
}

$previousKey = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process')
$secureKey = $null
$keyBuffer = [IntPtr]::Zero
$locationPushed = $false
try {
    if ($usesApi) {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            throw 'This key-loading wrapper requires Windows DPAPI.'
        }
        if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
            throw 'LOCALAPPDATA must identify the current Windows user profile.'
        }
        $vaultDirectory = Join-Path ([IO.Path]::GetFullPath($env:LOCALAPPDATA)) 'ProjectGecko'
        $vaultFile = Join-Path $vaultDirectory 'typesafe-api-key.dpapi'
        if (-not [IO.File]::Exists($vaultFile)) {
            throw 'No saved TypeSafe key. Run scripts/Set-JevKey.ps1 in a local PowerShell terminal first.'
        }
        foreach ($path in @($vaultDirectory, $vaultFile)) {
            if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'The key location must not contain a symbolic link or junction.'
            }
        }
        try {
            $secureKey = ConvertTo-SecureString -String ([IO.File]::ReadAllText($vaultFile)) -ErrorAction Stop
            if ($secureKey.Length -lt 1 -or $secureKey.Length -gt 4096) { throw 'Invalid key length.' }
        } catch {
            throw 'The saved TypeSafe key cannot be decrypted. Run Set-JevKey.ps1 using this Windows user on this machine.'
        }
        $keyBuffer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyBuffer), 'Process')
    } else {
        # Offline runs do not inherit a credential and never read the vault.
        [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $null, 'Process')
    }

    Push-Location -LiteralPath $repoRoot
    $locationPushed = $true
    & $nodeCommand.Source @cliArguments
    if ($LASTEXITCODE -ne 0) { throw ('Jev research CLI exited with code ' + $LASTEXITCODE + '.') }
} finally {
    [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $previousKey, 'Process')
    if ($keyBuffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyBuffer) }
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    if ($locationPushed) { Pop-Location }
}
