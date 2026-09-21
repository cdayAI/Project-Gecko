#Requires -Version 5.1
<#
.SYNOPSIS
Save a TypeSafe API key using Windows DPAPI for the current Windows user.
.DESCRIPTION
Prompts without echo. No network request is made and no service is enabled.
The encrypted file has a fixed location outside the repository.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This key setup requires Windows DPAPI.'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not [IO.Path]::IsPathRooted($env:LOCALAPPDATA)) {
    throw 'LOCALAPPDATA must identify the current Windows user profile.'
}

$vaultDirectory = Join-Path ([IO.Path]::GetFullPath($env:LOCALAPPDATA)) 'ProjectGecko'
$vaultFile = Join-Path $vaultDirectory 'typesafe-api-key.dpapi'
$temporaryFile = $null
$secureKey = $null
try {
    $secureKey = Read-Host 'TypeSafe API key (hidden; stored encrypted for this Windows user)' -AsSecureString
    if ($secureKey.Length -lt 1 -or $secureKey.Length -gt 4096) {
        throw 'The API key must contain between 1 and 4096 characters.'
    }
    $encrypted = ConvertFrom-SecureString -SecureString $secureKey
    [IO.Directory]::CreateDirectory($vaultDirectory) | Out-Null
    if (((Get-Item -LiteralPath $vaultDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The key directory must not be a symbolic link or junction.'
    }
    if (Test-Path -LiteralPath $vaultFile) {
        if (((Get-Item -LiteralPath $vaultFile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The key file must not be a symbolic link.'
        }
    }

    $temporaryFile = Join-Path $vaultDirectory ('.typesafe-key-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporaryFile, $encrypted, [Text.UTF8Encoding]::new($false))
    $permissions = [Security.AccessControl.FileSecurity]::new()
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $permissions.SetOwner($userSid)
    $permissions.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $systemSid)) {
        $permissions.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow
        ))
    }
    Set-Acl -LiteralPath $temporaryFile -AclObject $permissions
    if ([IO.File]::Exists($vaultFile)) {
        # Replace preserves the destination DACL. Refuse unexpected broader access.
        $existingPermissions = Get-Acl -LiteralPath $vaultFile
        $existingRules = $existingPermissions.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        $unexpectedRules = @($existingRules | Where-Object {
            $_.IdentityReference.Value -ne $userSid.Value -and $_.IdentityReference.Value -ne $systemSid.Value
        })
        if (-not $existingPermissions.AreAccessRulesProtected -or $unexpectedRules.Count -ne 0) {
            throw 'The existing encrypted key has unexpected file permissions. Restore private permissions before replacing it.'
        }
        [IO.File]::Replace($temporaryFile, $vaultFile, [NullString]::Value)
    } else {
        [IO.File]::Move($temporaryFile, $vaultFile)
    }
    Write-Host 'TypeSafe key saved encrypted for this Windows user. No API request was made.'
    Write-Host 'Use Invoke-Jev.ps1 -Mode status to inspect the research setup without decrypting the key.'
} finally {
    if ($null -ne $secureKey) { $secureKey.Dispose() }
    if ($null -ne $temporaryFile -and [IO.File]::Exists($temporaryFile)) {
        [IO.File]::Delete($temporaryFile)
    }
}
