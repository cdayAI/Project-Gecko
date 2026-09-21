// Sector ETF proxy per symbol, shared by the gap scanner and the gap-and-go
// diagnostics. Unlisted names map to SPY. Static and hand-maintained.

const SECTOR: Record<string, string> = Object.fromEntries([
  ...["NVDA", "AMD", "AVGO", "INTC", "MU", "QCOM", "ARM", "TSM", "ASML", "SMCI", "DELL", "HPQ", "SNDK", "WDC", "STX", "MRVL", "AMAT", "LRCX", "KLAC", "ON", "MCHP", "TXN", "ADI", "NXPI", "MPWR", "SWKS", "QRVO", "TER", "ENTG", "COHR", "LITE", "AAOI", "CRDO", "ALAB", "RMBS", "MXL", "AEHR", "ACMR", "ACLS", "AXTI", "WOLF", "POET", "SITM", "VICR", "NBIS", "APLD", "CIFR", "CORZ", "WULF", "IREN", "HUT"].map((s) => [s, "SMH"]),
  ...["MRNA", "BNTX", "CRSP", "VRTX", "REGN", "GILD", "AMGN", "HIMS", "TEM", "BEAM", "EDIT", "NTLA", "GRAL", "SDGR", "TNDM", "EXAS", "ILMN", "ALNY", "IONS", "SRPT", "BMRN", "INCY", "NBIX", "RARE", "ARWR", "RXRX"].map((s) => [s, "XBI"]),
  ...["JPM", "BAC", "C", "WFC", "GS", "MS", "SCHW", "BLK", "AXP", "COF", "KKR", "HOOD", "SOFI", "AFRM", "UPST", "PYPL", "XYZ", "V", "MA", "COIN", "MSTR", "ALL", "PGR", "TRV", "MET", "PRU", "AIG", "BX", "APO", "ARES", "IBKR", "LPLA", "RJF", "MARA", "RIOT", "CLSK", "BTBT", "RSI"].map((s) => [s, "XLF"]),
  ...["XOM", "CVX", "OXY", "DVN", "SLB", "HAL", "COP", "EOG", "PXD", "FANG", "MPC", "VLO", "PSX", "OVV", "PR", "MGY", "AR", "RRC", "NOG", "CRGY", "TALO", "MTDR", "CHRD", "MUR", "SM", "CTRA", "APA", "HES", "WFRD", "RIG", "VAL", "NE", "BKR", "FTI", "CXW"].map((s) => [s, "XLE"]),
  ...["AAPL", "MSFT", "CRM", "ORCL", "ADBE", "PLTR", "SNOW", "CRWD", "PANW", "ZS", "NET", "DDOG", "MDB", "SHOP", "IONQ", "RGTI", "QBTS", "QUBT", "SOUN", "BBAI", "AI", "U", "NOW", "INTU", "WDAY", "TEAM", "OKTA", "FSLY", "DOCN", "TWLO", "RBRK", "DBX", "BOX", "TWLO", "GTLB", "ESTC", "CFLT", "S", "ZM", "DOCU", "HUBS", "VG"].map((s) => [s, "XLK"]),
  ...["PFE", "MRK", "JNJ", "LLY", "NVO", "ABBV", "BMY", "UNH", "CVS", "ISRG", "TMO", "DHR", "ABT", "MDT", "SYK", "BSX", "ZTS", "CI", "ELV", "HUM", "CNC", "MOH", "DXCM", "PODD", "ALGN", "EW"].map((s) => [s, "XLV"]),
  ...["BA", "LMT", "RTX", "NOC", "GE", "CAT", "DE", "HON", "UNP", "UPS", "FDX", "DAL", "UAL", "AAL", "LUV", "RKLB", "ASTS", "LUNR", "ACHR", "JOBY", "SPCX", "GD", "LHX", "HII", "TDG", "ETN", "EMR", "PH", "ITW", "MMM", "CSX", "NSC", "WM", "RSG", "URI", "PWR", "FLY", "RDW", "CON", "GEV", "VST", "CEG", "NRG", "OKLO", "SMR", "NNE", "PLUG", "ENPH", "FSLR", "RUN"].map((s) => [s, "XLI"]),
  ...["AMZN", "TSLA", "HD", "LOW", "TGT", "NKE", "SBUX", "MCD", "CMG", "CCL", "RCL", "NCLH", "MAR", "LULU", "RIVN", "LCID", "NIO", "XPEV", "LI", "F", "GM", "GME", "AMC", "ABNB", "UBER", "DKNG", "RBLX", "BKNG", "EXPE", "TJX", "ROST", "OLLI", "DG", "DLTR", "ULTA", "CPRI", "TPR", "RL", "PVH", "WBD", "DIS", "NFLX", "ROKU", "SPOT", "META", "GOOGL", "SNAP", "PINS", "P", "SGHC", "KDP", "MDLZ", "PEP", "KO", "WMT", "COST", "KR", "PG", "CL", "MTDR"].map((s) => [s, "XLY"]),
]);

export const SECTOR_ETFS = ["SPY", "QQQ", "IWM", "SMH", "XBI", "XLF", "XLE", "XLK", "XLV", "XLI", "XLY"] as const;

export function sectorFor(symbol: string): string {
  return SECTOR[symbol.toUpperCase()] ?? "SPY";
}
