// Windows research credentials shared with work/schwab-readonly/saved_probe.py.
// Only encrypted bytes reach disk. PowerShell receives secrets through captured
// pipes, never command arguments, environment variables, or inherited consoles.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { SchwabAuth, type SchwabTokenStore } from "./auth.js";
import type { PersistedTokens } from "./types.js";

const REDIRECT_URI = "https://127.0.0.1";
const VAULT_ERROR = "Windows Schwab credentials could not be loaded; check the local encrypted OAuth setup.";
const SAVE_ERROR = "Windows Schwab credentials could not be saved; the vault may have changed. Reload before retrying.";

interface VaultBundle extends Record<string, unknown> {
  schema_version: 1;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  obtained_at_utc: string;
  authorization_obtained_at_utc?: string;
  tokens: Record<string, unknown> & { access_token: string; refresh_token: string; expires_in: number };
}

// The script is constant. Values enter only through stdin. Diagnostics are
// intentionally generic even when DPAPI, JSON decoding, or filesystem I/O fail.
const VAULT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$lock = $null
$temporary = $null
try {
  Add-Type -AssemblyName System.Security
  $inputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $target = [IO.Path]::GetFullPath([string]$inputData.path)
  $sha = [Security.Cryptography.SHA256]::Create()
  if ($inputData.operation -eq 'read') {
    $cipher = [IO.File]::ReadAllBytes($target)
    if ($cipher.Length -eq 0 -or $cipher.Length -gt 131072) { throw 'invalid' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $bundle = $utf8.GetString($plain) | ConvertFrom-Json
    $digest = [BitConverter]::ToString($sha.ComputeHash($cipher)).Replace('-', '').ToLowerInvariant()
    [Console]::Out.Write((@{ bundle = $bundle; digest = $digest } | ConvertTo-Json -Depth 64 -Compress))
  } elseif ($inputData.operation -eq 'save') {
    # Cooperating Gecko writers serialize; the digest also rejects prior writes
    # by the legacy Python helper. Do not run both scanners concurrently.
    $lock = New-Object IO.FileStream(($target + '.gecko-lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    $before = [IO.File]::ReadAllBytes($target)
    $digest = [BitConverter]::ToString($sha.ComputeHash($before)).Replace('-', '').ToLowerInvariant()
    if ($digest -ne [string]$inputData.expectedDigest) { throw 'changed' }
    $plain = $utf8.GetBytes(($inputData.bundle | ConvertTo-Json -Depth 64 -Compress))
    $cipher = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($cipher.Length -gt 131072) { throw 'invalid' }
    $temporary = [IO.Path]::Combine([IO.Path]::GetDirectoryName($target), ('.gecko-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $acl = New-Object Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')))
      $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'Allow')))
      $stream.Write($cipher, 0, $cipher.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
    [IO.File]::SetAccessControl($temporary, $acl)
    $current = [IO.File]::ReadAllBytes($target)
    $digest = [BitConverter]::ToString($sha.ComputeHash($current)).Replace('-', '').ToLowerInvariant()
    if ($digest -ne [string]$inputData.expectedDigest) { throw 'changed' }
    [IO.File]::Replace($temporary, $target, [NullString]::Value)
    $temporary = $null
    $digest = [BitConverter]::ToString($sha.ComputeHash($cipher)).Replace('-', '').ToLowerInvariant()
    [Console]::Out.Write((@{ digest = $digest } | ConvertTo-Json -Compress))
  } else { throw 'invalid' }
} catch {
  [Console]::Error.Write('Encrypted credential operation failed.')
  exit 1
} finally {
  if ($temporary -and [IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  if ($lock) { $lock.Dispose() }
}
`;

export function discoverWindowsVaultPath(localAppData: string): string | null {
  try {
    const relativeVault = path.join("ProjectGecko", "Schwab", "credentials.dpapi");
    const standard = path.join(localAppData, relativeVault);
    // Packaged Codex can virtualize this ordinary path. Pin the physical file
    // so refreshes update the same encrypted vault from either terminal.
    if (existsSync(standard)) return realpathSync.native(standard);

    const packages = path.join(localAppData, "Packages");
    if (!existsSync(packages)) return null;
    const candidates = readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^OpenAI\.Codex_[a-z0-9]+$/i.test(entry.name))
      .map((entry) => path.join(packages, entry.name, "LocalCache", "Local", relativeVault))
      .filter((candidate) => existsSync(candidate));
    if (candidates.length > 1) {
      throw new Error("Multiple saved Windows Schwab vaults found; resolve the ambiguous local credential setup before retrying.");
    }
    return candidates.length === 1 ? realpathSync.native(candidates[0]!) : null;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Multiple saved Windows Schwab vaults found;")) throw error;
    throw new Error(VAULT_ERROR);
  }
}

export function windowsVaultPath(): string | null {
  const local = process.env.LOCALAPPDATA;
  return process.platform === "win32" && local ? discoverWindowsVaultPath(local) : null;
}

export function hasWindowsVault(): boolean {
  const location = windowsVaultPath();
  return location !== null && existsSync(location);
}

// Optional path is for isolated tests. The scanner discovers the per-user vault.
export async function loadWindowsVaultAuth(location: string | null = windowsVaultPath()): Promise<SchwabAuth | null> {
  if (process.platform !== "win32" || location === null || !existsSync(location)) return null;
  const store = await WindowsVaultTokenStore.open(location);
  const auth = new SchwabAuth(store.authConfig(), store);
  if (!await auth.load()) throw new Error(VAULT_ERROR);
  return auth;
}

export class WindowsVaultTokenStore implements SchwabTokenStore {
  private constructor(
    private readonly location: string,
    private bundle: VaultBundle,
    private digest: string,
  ) {}

  static async open(location: string): Promise<WindowsVaultTokenStore> {
    try {
      const physicalLocation = realpathSync.native(location);
      const result = await vaultRequest({ operation: "read", path: physicalLocation });
      if (!record(result) || !validDigest(result.digest)) throw new Error(VAULT_ERROR);
      return new WindowsVaultTokenStore(physicalLocation, parseBundle(result.bundle), result.digest);
    } catch {
      throw new Error(VAULT_ERROR);
    }
  }

  authConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
    return { clientId: this.bundle.client_id, clientSecret: this.bundle.client_secret, redirectUri: this.bundle.redirect_uri };
  }

  async load(): Promise<PersistedTokens> {
    return bundleTokens(this.bundle);
  }

  async save(tokens: PersistedTokens): Promise<void> {
    try {
      const before = bundleTokens(this.bundle);
      // This adapter only refreshes the existing authorization. A new login
      // belongs to the established local OAuth helper, not this scanner.
      if (tokens.refreshTokenIssuedAt !== before.refreshTokenIssuedAt) throw new Error(SAVE_ERROR);
      const now = Date.now();
      const updated = parseBundle({
        ...this.bundle,
        authorization_obtained_at_utc: this.bundle.authorization_obtained_at_utc ?? this.bundle.obtained_at_utc,
        obtained_at_utc: new Date(now).toISOString(),
        last_refresh_at_utc: new Date(now).toISOString(),
        tokens: {
          ...this.bundle.tokens,
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: (tokens.accessTokenExpiresAt - now) / 1000,
        },
      });
      const result = await vaultRequest({ operation: "save", path: this.location, expectedDigest: this.digest, bundle: updated });
      if (!record(result) || !validDigest(result.digest)) throw new Error(SAVE_ERROR);
      this.bundle = updated;
      this.digest = result.digest;
    } catch {
      throw new Error(SAVE_ERROR);
    }
  }
}

function parseBundle(value: unknown): VaultBundle {
  if (!record(value) || value.schema_version !== 1 || !secret(value.client_id) || value.client_id.includes(":") ||
      !secret(value.client_secret) || value.redirect_uri !== REDIRECT_URI || !record(value.tokens) ||
      !secret(value.tokens.access_token) || !secret(value.tokens.refresh_token) ||
      (value.tokens.token_type !== undefined && String(value.tokens.token_type).toLowerCase() !== "bearer") ||
      typeof value.tokens.expires_in !== "number" || !Number.isFinite(value.tokens.expires_in) ||
      value.tokens.expires_in <= 0 || value.tokens.expires_in > 86_400) throw new Error(VAULT_ERROR);
  const obtained = timestamp(value.obtained_at_utc);
  const authorized = timestamp(value.authorization_obtained_at_utc ?? value.obtained_at_utc);
  if (authorized > obtained || obtained > Date.now() + 60_000 || !Number.isFinite(obtained + value.tokens.expires_in * 1000)) {
    throw new Error(VAULT_ERROR);
  }
  return value as VaultBundle;
}

function bundleTokens(bundle: VaultBundle): PersistedTokens {
  return {
    accessToken: bundle.tokens.access_token,
    refreshToken: bundle.tokens.refresh_token,
    accessTokenExpiresAt: timestamp(bundle.obtained_at_utc) + bundle.tokens.expires_in * 1000,
    refreshTokenIssuedAt: timestamp(bundle.authorization_obtained_at_utc ?? bundle.obtained_at_utc),
  };
}

function timestamp(value: unknown): number {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value)) throw new Error(VAULT_ERROR);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(VAULT_ERROR);
  return parsed;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secret(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,32768}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function vaultRequest(request: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32" || !process.env.SystemRoot) {
      reject(new Error(VAULT_ERROR));
      return;
    }
    const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(VAULT_SCRIPT, "utf16le").toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) { reject(new Error(VAULT_ERROR)); return; }
        try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, ""))); }
        catch { reject(new Error(VAULT_ERROR)); }
      });
    child.stdin?.on("error", () => reject(new Error(VAULT_ERROR)));
    child.stdin?.end(JSON.stringify(request));
  });
}
