# TypeSafe key setup on Windows

Run these commands in a local PowerShell terminal from this repository. Keep the key out of chat, command arguments, source files, `.env`, and screenshots.

```powershell
.\scripts\Set-JevKey.ps1
```

Paste the TypeSafe API key only into that hidden terminal prompt, then press Enter. The script makes no API request and enables no recurring process. It stores Windows DPAPI ciphertext at `%LOCALAPPDATA%\ProjectGecko\typesafe-api-key.dpapi`, outside the repository. The file permits access to the current Windows user and SYSTEM. Decryption requires the corresponding Windows user profile; use the setup prompt again after moving to another machine or replacing a key. Re-running setup replaces the encrypted file atomically.

## Offline verification

```powershell
.\scripts\Invoke-Jev.ps1 -Mode status
.\scripts\Invoke-Jev.ps1 -Mode demo
```

The default mode is `status`. Neither command reads or decrypts the saved key, and the wrapper removes an inherited `TYPESAFE_API_KEY` from the child environment for offline runs. These modes do not establish successful authentication or live model quality.

## Explicit bounded live research

After the key is saved and you choose to authorize one inference request, verify authentication using a synthetic example that does not depend on fresh news:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode probe -MaxRequests 1
```

Probe mode requires exactly `-MaxRequests 1`. It is an authenticated API request and may incur an inference charge. Its journal is explicitly tagged `AUTHENTICATED_SYNTHETIC_PROBE`; it is not live market evidence or exportable live research. It verifies the connection and response handling, not trading accuracy.

For a bounded run against current news or supplied evidence:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode live -MaxRequests 3
```

Live mode requires an explicit positive request cap. In live or probe mode, the wrapper decrypts the saved key into a temporary process environment variable, starts the isolated research CLI, and restores the previous environment and working directory on success or failure. It does not start the trading engine, place orders, or create a scheduled monitor. The request cap bounds requests, not their precise dollar cost; input size and the provider's current price also matter.

Optional bounded parameters:

```powershell
.\scripts\Invoke-Jev.ps1 -Mode live -MaxRequests 3 -MaxEvents 20 -MaxAgeMinutes 1440 -NewsDirectory data/news -Directory data/jev
```

For attributed full text or thesis inputs, add `-EvidenceFile data/your-evidence.json`; consult the Jev integration guide for that input schema. Relative paths resolve against this repository even when the script is invoked from another working directory. Arguments are passed directly to Node as an array, without assembling a shell command. The wrapper supports `MaxRequests` and `MaxEvents` from 1 through 1000, and `MaxAgeMinutes` from 1 through 44640 (31 days). The CLI may apply additional constraints.

The key necessarily exists briefly in the Node process environment and memory during live requests. Avoid debug environment dumps or running the CLI under an untrusted process inspector. No key or authentication response should be copied into research reports.

## Credential regression checks

```powershell
pwsh -NoProfile -File .\scripts\Test-JevKeyStorage.ps1
```

This offline test requires PowerShell 7.2 or later and installed repository dependencies. It uses a synthetic secret and an isolated temporary `LOCALAPPDATA`. It does not access the real credential vault or call TypeSafe. It verifies encrypted storage, replacement, credential-free offline modes, explicit live request limits, argument handling, and environment restoration when the child succeeds or fails. The setup and runner scripts support Windows PowerShell 5.1 or later.
