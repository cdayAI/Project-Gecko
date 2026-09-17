// Webull OpenAPI response shapes used by the research engine.
//
// Field names for snapshots, depth quotes, and bars were observed on
// 2026-09-16 through Webull's own data tools (same OpenAPI backend) and
// match the documented snapshot example on
// developer.webull.com/apis/docs/market-data-api/data-api. Numeric fields
// arrive as strings. Option snapshot/reference shapes were observed in
// authenticated sandbox HTTP-200 responses on 2026-09-17; parsers preserve
// source times and delay metadata independently of the host environment.

export interface WebullStockSnapshotRaw {
  readonly symbol?: string;
  readonly instrument_id?: string;
  readonly price?: string;
  readonly open?: string;
  readonly high?: string;
  readonly low?: string;
  readonly close?: string;
  readonly pre_close?: string;
  readonly volume?: string;
  readonly change?: string;
  readonly change_ratio?: string;
  readonly last_trade_time?: number;
  readonly quote_time?: number;
  readonly delay_minutes?: number;
  readonly bid?: string;
  readonly ask?: string;
  readonly bid_size?: string;
  readonly ask_size?: string;
  readonly extend_hour_last_price?: string;
  readonly extend_hour_change_ratio?: string;
  readonly fifty_two_wk_high?: string;
  readonly fifty_two_wk_low?: string;
  readonly trade_status?: string;
}

export interface WebullBarRaw {
  readonly time?: string;              // ISO, e.g. "2026-09-16T04:00:00.000+0000"
  readonly open?: string;
  readonly high?: string;
  readonly low?: string;
  readonly close?: string;
  readonly volume?: string;
  readonly trading_session?: string;
}

export interface WebullBarsResponseRaw {
  readonly result?: readonly {
    readonly symbol?: string;
    readonly instrument_id?: string;
    readonly delay_minutes?: number;
    readonly result?: readonly WebullBarRaw[];
  }[];
}

export interface WebullScreenerRowRaw {
  readonly symbol?: string;
  readonly name?: string;
  readonly price?: string;
  readonly close?: string;
  readonly change_ratio?: string;
  readonly volume?: string;
  readonly market_value?: string;
}

export interface WebullScreenerResponseRaw {
  readonly data?: readonly WebullScreenerRowRaw[];
  readonly has_more?: boolean;
}

export interface WebullEarningsRowRaw {
  readonly fiscal_year?: number;
  readonly fiscal_period?: number;
  readonly expected_publish_date?: string;   // YYYY-MM-DD
  readonly eps_actual?: string;
  readonly eps_est?: string;
}

export interface WebullTokenRaw {
  readonly token?: string;
  readonly expires?: number | string;
  readonly status?: string;            // PENDING | NORMAL | INVALID | EXPIRED
}
