// Offline only: synthetic per-user DPAPI vaults and mocked OAuth responses.
// Never reads the real vault, connects to Schwab, or creates plaintext tokens.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { setLogLevel } from "../../core/logger.js";
import { SchwabAuth, type SchwabTokenStore } from "./auth.js";
import type { PersistedTokens } from "./types.js";
import { discoverWindowsVaultPath, loadWindowsVaultAuth, windowsVaultPath, WindowsVaultTokenStore } from "./windows-vault.js";

const SENTINEL = "SYNTHETIC_SCHWAB_SECRET_MUST_NOT_LEAK";
const identity = { clientId: "synthetic-app", clientSecret: SENTINEL, redirectUri: "https://127.0.0.1" };
const now = Date.now();
const initial: PersistedTokens = {
  accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
  accessTokenExpiresAt: now + 1_800_000, refreshTokenIssuedAt: now - 86_400_000,
};
const bundle = {
  schema_version: 1, client_id: identity.clientId, client_secret: identity.clientSecret,
  redirect_uri: identity.redirectUri, obtained_at_utc: new Date(now).toISOString(),
  authorization_obtained_at_utc: new Date(initial.refreshTokenIssuedAt).toISOString(),
  research_note: "preserve-this-field",
  tokens: { access_token: initial.accessToken, refresh_token: initial.refreshToken, expires_in: 1800, token_type: "Bearer", scope: "synthetic-scope" },
};

function fixture(location: string, data: unknown): void {
  const script = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $u=New-Object Text.UTF8Encoding($false); $p=$u.GetBytes([Console]::In.ReadToEnd()); $c=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($c))`;
  const encoded = powershell(script, JSON.stringify(data));
  fs.writeFileSync(location, Buffer.from(encoded, "base64"));
}

function decodedFixture(location: string): Record<string, unknown> {
  const script = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $u=New-Object Text.UTF8Encoding($false); $c=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write($u.GetString($p))`;
  return JSON.parse(powershell(script, fs.readFileSync(location).toString("base64"))) as Record<string, unknown>;
}

function powershell(script: string, input: string): string {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    return execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")],
      { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  } catch { throw new Error("Synthetic DPAPI fixture operation failed."); }
}

function hash(location: string): string {
  return createHash("sha256").update(fs.readFileSync(location)).digest("hex");
}

async function errorText(operation: () => Promise<unknown>): Promise<string> {
  try { await operation(); } catch (err) { return err instanceof Error ? err.message : String(err); }
  throw new Error("Expected the synthetic operation to fail.");
}

async function main(): Promise<void> {
  assert.equal(process.platform, "win32", "DPAPI tests require Windows");
  setLogLevel("error");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (): Promise<Response> => { throw new Error("Network is disabled in this selftest."); };
  // Keep nested package fixtures below legacy Windows PowerShell's path limit;
  // the repository's dated workspace path is already unusually long.
  const parent = path.resolve(homedir(), ".codex", "tmp");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "schwab-vault-selftest-"));
  const location = path.join(directory, "credentials.dpapi");
  const originalDirectory = process.cwd();
  const originalLocalAppData = process.env.LOCALAPPDATA;
  process.chdir(directory);
  let passed = 0;
  const check = (): void => { passed++; };
  try {
    assert.equal(await loadWindowsVaultAuth(path.join(directory, "absent.dpapi")), null); check();
    fixture(location, bundle);
    const originalHash = hash(location);
    const store = await WindowsVaultTokenStore.open(location);
    assert.deepEqual(await store.load(), initial); check();
    assert.equal(store.authConfig().redirectUri, identity.redirectUri); check();
    const auth = await loadWindowsVaultAuth(location);
    assert(auth);
    assert.equal(await auth.getAccessToken(), initial.accessToken);
    assert.equal(hash(location), originalHash); check();

    await store.save({ ...initial, accessToken: "synthetic-refreshed-access", accessTokenExpiresAt: Date.now() + 1_800_000 });
    const encrypted = fs.readFileSync(location);
    assert(!encrypted.includes(Buffer.from(SENTINEL)));
    assert(!encrypted.includes(Buffer.from("synthetic-refreshed-access"))); check();
    const reopened = await WindowsVaultTokenStore.open(location);
    assert.equal((await reopened.load()).accessToken, "synthetic-refreshed-access");
    assert.equal((await reopened.load()).refreshTokenIssuedAt, initial.refreshTokenIssuedAt); check();
    const saved = decodedFixture(location);
    assert.equal(saved.research_note, bundle.research_note);
    assert.equal(saved.authorization_obtained_at_utc, bundle.authorization_obtained_at_utc);
    assert.equal((saved.tokens as Record<string, unknown>).scope, "synthetic-scope"); check();

    fixture(location, { ...bundle, authorization_obtained_at_utc: undefined });
    const oldFormat = await WindowsVaultTokenStore.open(location);
    await oldFormat.save({ ...await oldFormat.load(), accessTokenExpiresAt: Date.now() + 1_800_000 });
    assert.equal(decodedFixture(location).authorization_obtained_at_utc, bundle.obtained_at_utc); check();

    fixture(location, bundle);
    const stale = await WindowsVaultTokenStore.open(location);
    fixture(location, { ...bundle, external_writer: "newer-data" });
    const externallyChangedHash = hash(location);
    assert.match(await errorText(() => stale.save(initial)), /may have changed/);
    assert.equal(hash(location), externallyChangedHash); check();

    const [writerA, writerB] = await Promise.all([WindowsVaultTokenStore.open(location), WindowsVaultTokenStore.open(location)]);
    const competing = await Promise.allSettled([writerA.save(initial), writerB.save(initial)]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter((result) => result.status === "rejected").length, 1); check();
    assert.deepEqual(fs.readdirSync(directory), ["credentials.dpapi"]); check();

    for (const invalid of [
      { ...bundle, schema_version: 2 },
      { ...bundle, client_secret: SENTINEL + "\n" },
      { ...bundle, redirect_uri: "https://example.invalid" },
      { ...bundle, obtained_at_utc: "no-timezone" },
      { ...bundle, tokens: { ...bundle.tokens, expires_in: -1 } },
    ]) {
      fixture(location, invalid);
      const error = await errorText(() => WindowsVaultTokenStore.open(location));
      assert(!error.includes(SENTINEL));
      assert.match(error, /could not be loaded/);
      check();
    }
    fs.writeFileSync(location, Buffer.from(SENTINEL));
    assert(!((await errorText(() => WindowsVaultTokenStore.open(location))).includes(SENTINEL))); check();

    const captured: string[] = [];
    const originalStderr = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const broken: SchwabTokenStore = { load: async () => { throw new Error(SENTINEL); }, save: async () => {} };
      assert.equal(await new SchwabAuth(identity, broken).load(), false);
    } finally { process.stderr.write = originalStderr; }
    assert(!captured.join("").includes(SENTINEL)); check();

    const expired = { ...initial, accessTokenExpiresAt: now - 1000 };
    const memoryStore: SchwabTokenStore = { load: async () => expired, save: async () => {} };
    for (const response of [
      async (): Promise<Response> => new Response(SENTINEL, { status: 401 }),
      async (): Promise<Response> => new Response(SENTINEL, { status: 200 }),
      async (): Promise<Response> => new Response(JSON.stringify({ [SENTINEL]: SENTINEL }), { status: 200 }),
      async (): Promise<Response> => { throw new Error(SENTINEL); },
    ]) {
      globalThis.fetch = response;
      const broken = new SchwabAuth(identity, memoryStore);
      assert(await broken.load());
      const error = await errorText(() => broken.getAccessToken());
      assert(!error.includes(SENTINEL)); check();
    }

    let requests = 0;
    globalThis.fetch = async (_input, options): Promise<Response> => {
      requests++;
      assert.equal(options?.redirect, "error");
      return new Response(JSON.stringify({ access_token: "synthetic-next", refresh_token: "synthetic-refresh", expires_in: 1800, token_type: "Bearer" }));
    };
    const failedSave = new SchwabAuth(identity, { load: async () => expired, save: async () => { throw new Error(SENTINEL); } });
    assert(await failedSave.load());
    assert.match(await errorText(() => failedSave.getAccessToken()), /persistence failed/);
    assert.match(await errorText(() => failedSave.getAccessToken()), /persistence failed/);
    assert.equal(requests, 1); check();

    requests = 0;
    let writes = 0;
    const concurrent = new SchwabAuth(identity, { load: async () => expired, save: async (value) => {
      writes++;
      assert.equal(value.refreshTokenIssuedAt, initial.refreshTokenIssuedAt);
    } });
    assert(await concurrent.load());
    assert.deepEqual(await Promise.all([concurrent.getAccessToken(), concurrent.getAccessToken(), concurrent.getAccessToken()]), ["synthetic-next", "synthetic-next", "synthetic-next"]);
    assert.equal(requests, 1);
    assert.equal(writes, 1); check();
    let retainedRefresh = "";
    globalThis.fetch = async (): Promise<Response> => new Response(JSON.stringify({ access_token: "synthetic-next", expires_in: 1800, token_type: "Bearer" }));
    const omittedRefresh = new SchwabAuth(identity, { load: async () => expired, save: async (value) => { retainedRefresh = value.refreshToken; } });
    assert(await omittedRefresh.load());
    assert.equal(await omittedRefresh.getAccessToken(), "synthetic-next");
    assert.equal(retainedRefresh, initial.refreshToken); check();
    assert(!fs.existsSync(path.join(directory, "data", "oauth-tokens.json"))); check();

    // Reproduce an unpackaged terminal: the ordinary vault is absent, while
    // the encrypted fixture exists only in Codex's MSIX LocalCache tree.
    // Exercise the default loader without an explicit location override.
    globalThis.fetch = async (): Promise<Response> => { throw new Error("Network is disabled in discovery tests."); };
    const local = path.join(directory, "discovery");
    process.env.LOCALAPPDATA = local;
    const relativeVault = path.join("ProjectGecko", "Schwab", "credentials.dpapi");
    const standard = path.join(local, relativeVault);
    const packageVault = (family: string): string => path.join(local, "Packages", family, "LocalCache", "Local", relativeVault);
    assert.equal(discoverWindowsVaultPath(local), null);
    assert.equal(await loadWindowsVaultAuth(), null); check();
    const unrelated = packageVault("OtherApp_example");
    fs.mkdirSync(path.dirname(unrelated), { recursive: true });
    fixture(unrelated, bundle);
    assert.equal(discoverWindowsVaultPath(local), null); check();
    const packaged = packageVault("OpenAI.Codex_fixture1");
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fixture(packaged, bundle);
    assert(!fs.existsSync(standard));
    assert.equal(discoverWindowsVaultPath(local), fs.realpathSync.native(packaged));
    assert.equal(windowsVaultPath(), fs.realpathSync.native(packaged)); check();
    const discovered = await loadWindowsVaultAuth();
    assert(discovered);
    assert.equal(await discovered.getAccessToken(), initial.accessToken); check();
    const packageBefore = hash(packaged);
    const packageStore = await WindowsVaultTokenStore.open(windowsVaultPath()!);
    await packageStore.save({ ...initial, accessToken: "synthetic-package-refresh", accessTokenExpiresAt: Date.now() + 1_800_000 });
    assert.notEqual(hash(packaged), packageBefore);
    assert(!fs.existsSync(standard));
    assert.equal((await WindowsVaultTokenStore.open(packaged)).authConfig().clientId, identity.clientId); check();
    fs.mkdirSync(path.dirname(standard), { recursive: true });
    fs.writeFileSync(standard, "invalid-synthetic-encrypted-file");
    assert.equal(discoverWindowsVaultPath(local), fs.realpathSync.native(standard));
    assert.match(await errorText(() => loadWindowsVaultAuth()), /could not be loaded/); check();
    fixture(standard, bundle);
    assert.equal(await (await loadWindowsVaultAuth())!.getAccessToken(), initial.accessToken); check();
    fs.unlinkSync(standard);
    const second = packageVault("OpenAI.Codex_fixture2");
    fs.mkdirSync(path.dirname(second), { recursive: true });
    fixture(second, bundle);
    assert.throws(() => discoverWindowsVaultPath(local));
    assert.notEqual(await errorText(() => loadWindowsVaultAuth()), ""); check();
    fixture(standard, bundle);
    assert.equal(discoverWindowsVaultPath(local), fs.realpathSync.native(standard)); check();
    delete process.env.LOCALAPPDATA;
    assert.equal(windowsVaultPath(), null); check();
    process.stdout.write(JSON.stringify({ passed, scope: "synthetic DPAPI and mocked OAuth; no live credentials or network" }) + "\n");
  } catch {
    throw new Error(`Synthetic selftest failed after ${passed} checks.`);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    process.chdir(originalDirectory);
    // Verify the absolute target is exactly the unique test directory under
    // our intended workspace parent before deleting its synthetic fixtures.
    assert.equal(path.dirname(directory), parent);
    assert(path.basename(directory).startsWith("schwab-vault-selftest-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error && /^Synthetic selftest failed after \d+ checks\.$/.test(err.message)
    ? err.message : "Schwab vault offline selftest failed; sensitive diagnostics withheld.";
  process.stderr.write(message + "\n");
  process.exitCode = 1;
});
