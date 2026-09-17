// Selects the research data provider from config.
//
//   RESEARCH_PROVIDER=cboe    free, delayed, options only + Yahoo bars (default)
//   RESEARCH_PROVIDER=webull  Webull OpenAPI (WEBULL_APP_KEY/SECRET, subscriptions)
//   RESEARCH_PROVIDER=schwab  Schwab Trader API (existing OAuth tokens)

import type { AppConfig } from "../../core/types.js";
import { SchwabAuth } from "../../brokers/schwab/auth.js";
import { SchwabRest } from "../../brokers/schwab/rest.js";
import { CboeDelayedProvider } from "./cboe-delayed.js";
import type { MarketDataProvider } from "./provider.js";
import { SchwabProvider } from "./schwab-provider.js";
import { WebullClient } from "./webull/client.js";
import { WebullProvider } from "./webull/provider.js";

export function createResearchProvider(config: AppConfig, override?: string): MarketDataProvider {
  const choice = (override ?? config.researchProvider).toLowerCase();
  switch (choice) {
    case "cboe":
      return new CboeDelayedProvider();
    case "webull": {
      const client = new WebullClient({ appKey: config.webullAppKey, appSecret: config.webullAppSecret, env: config.webullEnv });
      // Delay is a property of each response, not of the hostname.
      return new WebullProvider(client);
    }
    case "schwab": {
      if (!config.schwabClientId || !config.schwabClientSecret) {
        throw new Error("RESEARCH_PROVIDER=schwab requires SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET");
      }
      const auth = new SchwabAuth({ clientId: config.schwabClientId, clientSecret: config.schwabClientSecret, redirectUri: config.schwabRedirectUri });
      return new SchwabProvider(new SchwabRest(auth));
    }
    default:
      throw new Error(`Unknown research provider: ${choice} (expected cboe, webull, or schwab)`);
  }
}
