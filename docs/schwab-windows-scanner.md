# Windows Schwab scanner connection

The gap scanner reuses the existing Project Gecko Research credentials saved
by the local Schwab setup under the current Windows user:

`%LOCALAPPDATA%\ProjectGecko\Schwab\credentials.dpapi`

When the setup runs inside the packaged Codex desktop app, Windows may redirect
that file into the app's private storage. A standalone PowerShell session does
not inherit that redirected view. If the ordinary location is absent, the
scanner discovers the same user's encrypted vault at:

`%LOCALAPPDATA%\Packages\OpenAI.Codex_<family>\LocalCache\Local\ProjectGecko\Schwab\credentials.dpapi`

The scanner resolves the physical path and uses that existing file directly.
It does not copy credentials. An existing ordinary vault has priority; an
unreadable vault or multiple packaged candidates produces an error. Regression
tests reproduce the missing-ordinary-path case through the default loader.
See [Microsoft's MSIX file-redirection documentation](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).

No new app keys, `.env` export, or plaintext token copy is needed when that
vault is present and its authorization remains valid. Windows DPAPI ties the
encrypted file to the Windows user and machine; copying it to a cloud runner
or another computer is not a portable credential setup.

## Check the connection

From this repository in PowerShell:

```powershell
npm run build
npm run schwab:selftest
npm run schwab:check
```

The check uses the scanner's real credential loader. It requests SPY/QQQ
quotes, one day of SPY minute history, and a small SPY options chain, then
exits. It prints data timestamps, available real-time/delay flags, and counts.
The self-test uses synthetic temporary credentials and mocked HTTP, without
reading the user's vault or making broker requests.
`CONNECTED` confirms connectivity and returned data; it does not qualify a
trade, prove feed coverage, or start a monitor. No universe build is needed.

For the existing premarket research screen (08:00–09:25 Eastern):

```powershell
npm run scan:gap -- --provider schwab
```

The scanner's historical statistics still use the saved universe cache or
Yahoo on cache misses. Its rows and strategy text are research output, and
still require the project's quote, catalyst, signal and risk checks before
manual trading. This connection repair does not validate scanner strategy
performance or make the broader trading bot ready to run.

## Credential and request boundaries

- The encrypted Windows vault takes precedence over legacy environment keys
  and `data/oauth-tokens.json`. An existing malformed/unreadable vault fails
  instead of silently switching to Yahoo or another credential set.
- Tokens refresh automatically when necessary. Updated credentials stay
  encrypted; the original browser-authorization lifetime is retained.
- Run one Schwab research process at a time. The new adapter detects changes
  and serializes its own writes, but the older Python helper does not share
  its lock. Concurrent independent refreshes are not supported.
- The scanner's client permits only fixed-host GETs for quotes, price history
  and option chains. It rejects account, order, preview, and other routes
  before requesting a token, and rejects HTTP redirects. OAuth refresh uses
  the fixed Schwab token endpoint separately.
- No account hash or AI-provider key is required for this scanner. Do not
  start the trading runtime (`npm run dev` / `npm start`) to test data access.
- When browser authorization expires, use the established local Schwab OAuth
  helper with the owned app and its exact callback, `https://127.0.0.1`.
  Do not paste credentials or redirect URLs containing authorization codes
  into chat. The older generic `npm run auth` flow has separate configuration
  requirements and is not the setup path for this encrypted vault.
