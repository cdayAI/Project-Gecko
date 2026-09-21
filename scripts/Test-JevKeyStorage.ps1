#Requires -Version 7.2
<#
.SYNOPSIS
Offline regression tests using a synthetic key and an isolated child process.
#>
[CmdletBinding()]
param([switch]$IsolatedChild)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'DPAPI regression tests require Windows.'
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $IsolatedChild) {
    $testRoot = Join-Path ([IO.Path]::GetTempPath()) ('gecko-jev-secret-test-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    [IO.File]::WriteAllText((Join-Path $testRoot '.synthetic-only'), 'isolated-dpapi-test')
    try {
        $processInfo = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
        $processInfo.UseShellExecute = $false
        foreach ($argument in @('-NoProfile', '-File', $PSCommandPath, '-IsolatedChild')) {
            $processInfo.ArgumentList.Add($argument)
        }
        $processInfo.Environment['LOCALAPPDATA'] = Join-Path $testRoot 'profile'
        $processInfo.Environment['GECKO_JEV_TEST_ROOT'] = $testRoot
        $processInfo.Environment['TYPESAFE_API_KEY'] = 'synthetic-inherited-key-not-a-credential'
        $child = [Diagnostics.Process]::Start($processInfo)
        $child.WaitForExit()
        if ($child.ExitCode -ne 0) { throw 'The isolated key storage tests failed.' }
    } finally {
        $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
        $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (-not $resolvedTestRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
            (Split-Path -Leaf $resolvedTestRoot) -notmatch '^gecko-jev-secret-test-[a-f0-9]{32}$') {
            throw 'Refusing cleanup outside the isolated temporary test directory.'
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
    return
}

# This guard prevents accidentally running the child against the real vault.
if ([string]::IsNullOrWhiteSpace($env:GECKO_JEV_TEST_ROOT)) { throw 'Missing isolated test directory.' }
$testRoot = [IO.Path]::GetFullPath($env:GECKO_JEV_TEST_ROOT)
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $testRoot) -notmatch '^gecko-jev-secret-test-[a-f0-9]{32}$' -or
    $env:LOCALAPPDATA -ne (Join-Path $testRoot 'profile') -or
    [IO.File]::ReadAllText((Join-Path $testRoot '.synthetic-only')) -ne 'isolated-dpapi-test' -or
    $env:TYPESAFE_API_KEY -ne 'synthetic-inherited-key-not-a-credential') {
    throw 'The key storage tests require their own isolated synthetic environment.'
}

function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('Regression failed: ' + $Message) }
}
function Invoke-ExpectFailure([scriptblock]$Action, [string]$Message) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert-Test $failed $Message
}
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if ($env:GECKO_JEV_SYNTHETIC_KEY -eq 'TEST_EMPTY') { return [Security.SecureString]::new() }
    return ConvertTo-SecureString -String $env:GECKO_JEV_SYNTHETIC_KEY -AsPlainText -Force
}

$fixtureRoot = Join-Path $repoRoot ('data/jev-key-test-' + [Guid]::NewGuid().ToString('N'))
$fixtureScripts = Join-Path $fixtureRoot 'scripts'
$fixtureSource = Join-Path $fixtureRoot 'src/research/jev'
[IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
[IO.Directory]::CreateDirectory($fixtureSource) | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Invoke-Jev.ps1') -Destination $fixtureScripts
$wrapper = Join-Path $fixtureScripts 'Invoke-Jev.ps1'
$setup = Join-Path $PSScriptRoot 'Set-JevKey.ps1'
$vaultDirectory = Join-Path $env:LOCALAPPDATA 'ProjectGecko'
$vaultFile = Join-Path $vaultDirectory 'typesafe-api-key.dpapi'
$probeFile = Join-Path $testRoot 'node-probe.json'
$env:GECKO_JEV_TEST_RESULT = $probeFile
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'package.json'), '{"type":"module"}')
[IO.File]::WriteAllText((Join-Path $fixtureSource 'jev-cli.ts'), @'
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync(process.env.GECKO_JEV_TEST_RESULT, JSON.stringify({
  args,
  cwd: process.cwd(),
  keyPresent: Boolean(process.env.TYPESAFE_API_KEY),
  keyMatches: process.env.TYPESAFE_API_KEY === process.env.GECKO_JEV_SYNTHETIC_KEY,
}));
if (args.includes('999')) process.exitCode = 7;
'@)

try {
    $startLocation = (Get-Location).Path
    $inherited = 'synthetic-inherited-key-not-a-credential'
    $env:GECKO_JEV_SYNTHETIC_KEY = 'synthetic-first-key-not-a-credential'
    & $setup
    $ciphertext = [IO.File]::ReadAllText($vaultFile)
    Assert-Test (-not $ciphertext.Contains('synthetic')) 'saved file must contain ciphertext only'
    Assert-Test ((Get-Acl -LiteralPath $vaultFile).AreAccessRulesProtected) 'key permissions must not inherit'
    $env:GECKO_JEV_SYNTHETIC_KEY = 'synthetic-replacement-key-not-a-credential'
    & $setup
    $replacement = [IO.File]::ReadAllText($vaultFile)
    Assert-Test ($replacement -ne $ciphertext) 'rotation must replace the ciphertext'
    $env:GECKO_JEV_SYNTHETIC_KEY = 'TEST_EMPTY'
    Invoke-ExpectFailure { & $setup } 'empty keys must be rejected'
    Assert-Test ([IO.File]::ReadAllText($vaultFile) -eq $replacement) 'failed setup must preserve prior key'
    $env:GECKO_JEV_SYNTHETIC_KEY = 'synthetic-replacement-key-not-a-credential'

    [IO.File]::WriteAllText($vaultFile, 'deliberately-invalid-ciphertext')
    foreach ($mode in @('status', 'demo')) {
        & $wrapper -Mode $mode
        $probe = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json
        Assert-Test (-not $probe.keyPresent) ($mode + ' must not inherit or decrypt a key')
        Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) ($mode + ' must restore the previous key environment')
        Assert-Test ((Get-Location).Path -eq $startLocation) ($mode + ' must restore the current location')
    }
    Invoke-ExpectFailure { & $wrapper -Mode live -MaxRequests 1 } 'corrupt DPAPI storage must fail closed'
    Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) 'decryption failure must restore environment'
    Remove-Item -LiteralPath $vaultFile
    Invoke-ExpectFailure { & $wrapper -Mode live -MaxRequests 1 } 'a missing vault must not fall back to an inherited credential'
    Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) 'missing vault failure must restore environment'
    [IO.File]::WriteAllText($vaultFile, $replacement)

    Remove-Item -LiteralPath $probeFile
    Invoke-ExpectFailure { & $wrapper -Mode live } 'live mode must require an explicit request cap'
    Invoke-ExpectFailure { & $wrapper -Mode live -MaxRequests 0 } 'zero request caps must be rejected'
    Invoke-ExpectFailure { & $wrapper -Mode probe } 'probe mode must require an explicit request cap'
    Invoke-ExpectFailure { & $wrapper -Mode probe -MaxRequests 2 } 'probe mode must accept only a one-request cap'
    Assert-Test (-not [IO.File]::Exists($probeFile)) 'invalid request caps must not invoke Node'
    & $wrapper -Mode probe -MaxRequests 1
    $probe = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json
    Assert-Test $probe.keyMatches 'probe child must receive the synthetic key'
    Assert-Test ($probe.args -contains '--probe') 'probe mode must be explicit'
    Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) 'probe must restore prior environment'
    & $wrapper -Mode live -MaxRequests 3 -Directory 'data/path with spaces;literal' -NewsDirectory 'data/news with spaces' -EvidenceFile 'data/evidence with spaces.json'
    $probe = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json
    Assert-Test $probe.keyMatches 'live child must receive the latest synthetic key'
    Assert-Test ($probe.args -contains 'data/path with spaces;literal') 'directory arguments must remain single literal values'
    Assert-Test ($probe.args -contains 'data/news with spaces') 'news directory arguments must remain single literal values'
    Assert-Test ($probe.args -contains 'data/evidence with spaces.json') 'evidence file arguments must remain single literal values'
    Assert-Test ($probe.cwd -eq $fixtureRoot) 'child must execute from its repository root'
    Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) 'successful live run must restore prior environment'
    Assert-Test ((Get-Location).Path -eq $startLocation) 'successful live run must restore location'

    Invoke-ExpectFailure { & $wrapper -Mode live -MaxRequests 1 -MaxEvents 999 } 'nonzero Node exit must propagate as failure'
    Assert-Test ($env:TYPESAFE_API_KEY -eq $inherited) 'failed live run must restore prior environment'
    Assert-Test ((Get-Location).Path -eq $startLocation) 'failed live run must restore location'
    [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $null, 'Process')
    & $wrapper
    $probe = Get-Content -LiteralPath $probeFile -Raw | ConvertFrom-Json
    Assert-Test ($probe.args -contains '--status') 'default mode must be offline status'
    Assert-Test ([string]::IsNullOrEmpty($env:TYPESAFE_API_KEY)) 'an absent prior key must remain absent'
    Write-Host 'PASS: isolated DPAPI storage, replacement, offline isolation, request limits, argument forwarding, and success/failure cleanup.'
} finally {
    $resolvedFixtureRoot = [IO.Path]::GetFullPath($fixtureRoot)
    $fixturePrefix = [IO.Path]::GetFullPath((Join-Path $repoRoot 'data')).TrimEnd('\') + '\'
    if (-not $resolvedFixtureRoot.StartsWith($fixturePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path -Leaf $resolvedFixtureRoot) -notmatch '^jev-key-test-[a-f0-9]{32}$') {
        throw 'Refusing cleanup outside the synthetic fixture directory.'
    }
    Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
}
