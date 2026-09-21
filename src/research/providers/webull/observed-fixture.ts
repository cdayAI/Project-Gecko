// Sanitized subset of HTTP-200 sandbox results captured 2026-09-17
// 16:11:13 UTC in outputs/webull-sandbox-connection.json. No credentials,
// account identifiers, or generated market values. Not a current quote.
export const OBSERVED_REFERENCE = Object.freeze({
  symbol: "SMCI260925C00040000", status: "LISTING", tradable_status: "OC",
  expiration_date: "2026-09-25", root_symbol: "SMCI", underlying_symbol: "SMCI",
  option_type: "CALL", style: "AMERICAN", strike_price: "40.0000000000",
  multiplier: "100.0000000000", settlement_method: "PHYSICAL", currency: "USD", def_type: "STANDARD",
});
export const OBSERVED_OPTION = Object.freeze({
  symbol: "SMCI260925C00040000", price: "1.72", bid: "1.70", ask: "1.72",
  volume: "3329", open_interest: "3269", gamma: "0.0954", delta: "0.5339",
  theta: "-0.1036", vega: "0.0239", imp_vol: "0.6917", strike_price: "40.00",
  last_trade_time: 1789661268081, quote_time: 1789661471189,
  ask_size: "34", bid_size: "12", delay_minutes: 0,
});
