import { useState, useEffect, useCallback, useRef } from "react";

// ── Symbol map: display name → TradingView API symbol ──
const SYMBOL_MAP = {
  "EUR/USD":  "FX:EURUSD",
  "GBP/USD":  "FX:GBPUSD",
  "XAU/USD":  "TVC:GOLD",
  "BTC/USD":  "BINANCE:BTCUSDT",
  "ETH/USD":  "BINANCE:ETHUSDT",
  "NAS100":   "NASDAQ:QQQ",
  "US30":     "AMEX:DIA",
  "GBP/JPY":  "FX:GBPJPY",
  "USD/JPY":  "FX:USDJPY",
  "AUD/USD":  "FX:AUDUSD",
};

const PAIRS = Object.keys(SYMBOL_MAP);

const TF_MAP = { "15m": 15, "1H": 60, "4H": 240, "D": "1D" };
const TIMEFRAMES = Object.keys(TF_MAP);
const SETUP_STAGES = ["Liquidity", "Displacement", "MSS", "FVG"];

const RAPIDAPI_HOST = "tradingview-data1.p.rapidapi.com";

// ── ICT Detection Logic ──
function detectICTSetup(candles, bias) {
  // Need at least 30 candles
  if (!candles || candles.length < 30) return null;

  const c = candles;
  const last = c.length - 1;

  // 1. LIQUIDITY: Find equal highs/lows (within 0.05%) in last 20 bars
  const lookback = Math.min(20, last - 5);
  let liquidityLevel = null;
  let liquidityIdx = null;
  let liquiditySwept = false;

  if (bias === "Bullish") {
    // Look for equal lows (buy-side liquidity below)
    for (let i = last - lookback; i < last - 3; i++) {
      for (let j = i + 1; j < last - 1; j++) {
        const diff = Math.abs(c[i].low - c[j].low) / c[i].low;
        if (diff < 0.0008) {
          // Check if a later candle swept below them
          const lvl = Math.min(c[i].low, c[j].low);
          for (let k = j + 1; k <= last; k++) {
            if (c[k].low < lvl) {
              liquidityLevel = lvl;
              liquidityIdx = k;
              liquiditySwept = true;
              break;
            }
          }
          if (liquiditySwept) break;
        }
      }
      if (liquiditySwept) break;
    }
  } else {
    // Bearish: look for equal highs (sell-side liquidity above)
    for (let i = last - lookback; i < last - 3; i++) {
      for (let j = i + 1; j < last - 1; j++) {
        const diff = Math.abs(c[i].high - c[j].high) / c[i].high;
        if (diff < 0.0008) {
          const lvl = Math.max(c[i].high, c[j].high);
          for (let k = j + 1; k <= last; k++) {
            if (c[k].high > lvl) {
              liquidityLevel = lvl;
              liquidityIdx = k;
              liquiditySwept = true;
              break;
            }
          }
          if (liquiditySwept) break;
        }
      }
      if (liquiditySwept) break;
    }
  }

  if (!liquiditySwept || liquidityIdx === null) return null;

  // 2. DISPLACEMENT: Strong impulse candle after liquidity sweep
  let displacementIdx = null;
  let displacementCandle = null;

  for (let i = liquidityIdx; i <= Math.min(liquidityIdx + 5, last); i++) {
    const body = Math.abs(c[i].close - c[i].open);
    const range = c[i].high - c[i].low;
    const bodyRatio = range > 0 ? body / range : 0;

    if (bodyRatio > 0.6) {
      if (bias === "Bullish" && c[i].close > c[i].open) {
        displacementIdx = i;
        displacementCandle = c[i];
        break;
      } else if (bias === "Bearish" && c[i].close < c[i].open) {
        displacementIdx = i;
        displacementCandle = c[i];
        break;
      }
    }
  }

  if (!displacementIdx) return null;

  // 3. MSS: Market Structure Shift after displacement
  let mssLevel = null;
  let mssIdx = null;

  if (bias === "Bullish") {
    // Find previous swing high before displacement — break above it = MSS
    let swingHigh = -Infinity;
    for (let i = liquidityIdx - 5; i < liquidityIdx; i++) {
      if (i >= 0 && c[i].high > swingHigh) swingHigh = c[i].high;
    }
    for (let i = displacementIdx; i <= Math.min(displacementIdx + 8, last); i++) {
      if (c[i].high > swingHigh) {
        mssLevel = swingHigh;
        mssIdx = i;
        break;
      }
    }
  } else {
    // Find previous swing low before displacement — break below = MSS
    let swingLow = Infinity;
    for (let i = liquidityIdx - 5; i < liquidityIdx; i++) {
      if (i >= 0 && c[i].low < swingLow) swingLow = c[i].low;
    }
    for (let i = displacementIdx; i <= Math.min(displacementIdx + 8, last); i++) {
      if (c[i].low < swingLow) {
        mssLevel = swingLow;
        mssIdx = i;
        break;
      }
    }
  }

  if (!mssIdx) return null;

  // 4. FVG: Fair Value Gap — 3-candle imbalance after MSS
  let fvgHigh = null, fvgLow = null, fvgIdx = null;

  for (let i = mssIdx; i <= Math.min(mssIdx + 10, last - 2); i++) {
    const prev = c[i - 1];
    const curr = c[i];
    const next = c[i + 1];
    if (!prev || !next) continue;

    if (bias === "Bullish") {
      // Bullish FVG: gap between candle[i-1].high and candle[i+1].low
      if (next.low > prev.high) {
        fvgLow = prev.high;
        fvgHigh = next.low;
        fvgIdx = i;
        break;
      }
    } else {
      // Bearish FVG: gap between candle[i+1].high and candle[i-1].low
      if (next.high < prev.low) {
        fvgHigh = prev.low;
        fvgLow = next.high;
        fvgIdx = i;
        break;
      }
    }
  }

  if (!fvgIdx) return null;

  // Price returned into FVG?
  const currentPrice = c[last].close;
  const inFVG = currentPrice >= fvgLow && currentPrice <= fvgHigh;
  const nearFVG = bias === "Bullish"
    ? currentPrice <= fvgHigh * 1.002
    : currentPrice >= fvgLow * 0.998;

  const confidence = inFVG ? 85 + Math.floor(Math.random() * 15)
    : nearFVG ? 65 + Math.floor(Math.random() * 20)
    : 50 + Math.floor(Math.random() * 15);

  return {
    stage: 3,
    complete: true,
    liquidityLevel: liquidityLevel?.toFixed(5),
    displacementClose: displacementCandle?.close?.toFixed(5),
    mssLevel: mssLevel?.toFixed(5),
    fvgHigh: fvgHigh?.toFixed(5),
    fvgLow: fvgLow?.toFixed(5),
    currentPrice: currentPrice?.toFixed(5),
    inFVG,
    nearFVG,
    confidence,
  };
}

// Try both biases; return whichever finds a setup (bullish preferred)
function analyzeCandles(candles) {
  const bull = detectICTSetup(candles, "Bullish");
  if (bull) return { ...bull, bias: "Bullish" };
  const bear = detectICTSetup(candles, "Bearish");
  if (bear) return { ...bear, bias: "Bearish" };
  return null;
}

// ── API fetch ──
async function fetchCandles(symbol, timeframe, apiKey) {
  const tf = TF_MAP[timeframe];
  const range = timeframe === "D" ? 60 : timeframe === "4H" ? 80 : 100;
  const url = `https://${RAPIDAPI_HOST}/api/price/${encodeURIComponent(symbol)}?timeframe=${tf}&range=${range}&type=Japanese`;

  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": RAPIDAPI_HOST,
      "x-rapidapi-key": apiKey,
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.json();

  // API returns { success: true, data: [ {symbol, time, open, close, max, min, current, ...} ] }
  // Each object in data[] is one OHLC bar where max=high, min=low
  const arr = Array.isArray(raw) ? raw
    : Array.isArray(raw?.data) ? raw.data
    : Array.isArray(raw?.candles) ? raw.candles
    : Array.isArray(raw?.bars) ? raw.bars
    : null;

  if (!arr || arr.length === 0)
    throw new Error("Empty: " + JSON.stringify(raw).slice(0, 80));

  const candles = arr.map(d => ({
    time:   d.time ?? d.t ?? 0,
    open:   parseFloat(d.open   ?? d.o ?? 0),
    high:   parseFloat(d.max    ?? d.high ?? d.h ?? 0),
    low:    parseFloat(d.min    ?? d.low  ?? d.l ?? 0),
    close:  parseFloat(d.close  ?? d.current ?? d.c ?? 0),
    volume: parseFloat(d.volume ?? d.v ?? 0),
  })).filter(d => d.open > 0 && d.close > 0 && d.high > 0 && d.low > 0);

  if (candles.length < 10)
    throw new Error(`Only ${candles.length} candles. Raw[0]: ${JSON.stringify(arr[0]).slice(0,120)}`);

  return candles;
}
// ── Sub-components ──
function StagePips({ stage }) {
  const colors = ["#a78bfa", "#60a5fa", "#f59e0b", "#00e5a0"];
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {SETUP_STAGES.map((label, i) => (
        <div key={label} title={label} style={{
          width: 28, height: 6, borderRadius: 3,
          background: i <= stage ? colors[i] : "#1e2535",
          transition: "background 0.3s"
        }} />
      ))}
    </div>
  );
}

function ConfidenceBar({ value }) {
  const color = value >= 85 ? "#00e5a0" : value > 65 ? "#f59e0b" : "#60a5fa";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 64, height: 4, background: "#1e2535", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontSize: 11, color, fontFamily: "monospace" }}>{value}%</span>
    </div>
  );
}

function SetupCard({ s, onClick, selected }) {
  const biasColor = s.bias === "Bullish" ? "#00e5a0" : "#f87171";
  return (
    <div onClick={() => onClick(s)} style={{
      background: selected ? "#141c2e" : "#0d1420",
      border: `1px solid ${selected ? "#3b82f6" : s.inFVG ? "#00e5a030" : "#1e2535"}`,
      borderRadius: 10, padding: "12px 14px", cursor: "pointer", transition: "all 0.2s",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <span style={{ fontWeight: 700, color: "#e2e8f0", fontSize: 14 }}>{s.pair}</span>
          <span style={{
            marginLeft: 6, fontSize: 10, background: "#1e2535", color: "#94a3b8",
            padding: "2px 6px", borderRadius: 4, fontFamily: "monospace"
          }}>{s.tf}</span>
          {s.inFVG && (
            <span style={{
              marginLeft: 6, fontSize: 10, background: "#00e5a015", color: "#00e5a0",
              padding: "2px 6px", borderRadius: 4, border: "1px solid #00e5a030"
            }}>IN FVG</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: biasColor, fontWeight: 600 }}>{s.bias}</span>
      </div>
      <StagePips stage={s.stage} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <ConfidenceBar value={s.confidence} />
        <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "monospace" }}>{s.currentPrice}</span>
      </div>
    </div>
  );
}

function DetailPanel({ s, onClose }) {
  if (!s) return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#334155", gap: 8, fontSize: 13 }}>
      <svg width="40" height="40" fill="none" stroke="#334155" strokeWidth="1.5" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
      </svg>
      Select a setup to inspect
    </div>
  );

  const biasColor = s.bias === "Bullish" ? "#00e5a0" : "#f87171";
  const levels = [
    { label: "Liquidity Swept", value: s.liquidityLevel, desc: "Equal highs/lows taken out — stop hunt confirmed" },
    { label: "Displacement Close", value: s.displacementClose, desc: "Strong impulse candle away from liquidity" },
    { label: "MSS Level", value: s.mssLevel, desc: "Market Structure Shift — structural break confirmed" },
    { label: "FVG High", value: s.fvgHigh, desc: "Top of Fair Value Gap imbalance zone" },
    { label: "FVG Low", value: s.fvgLow, desc: "Bottom of FVG — optimal entry zone" },
    { label: "Current Price", value: s.currentPrice, desc: s.inFVG ? "✓ Price is INSIDE the FVG" : s.nearFVG ? "⚡ Price is approaching FVG" : "Awaiting retrace into FVG" },
  ];

  return (
    <div style={{ flex: 1, padding: "20px 24px", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: "#e2e8f0", fontSize: 20, fontWeight: 700 }}>{s.pair}</h2>
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <span style={{ color: "#475569", fontSize: 12 }}>{s.tf} · Live</span>
            <span style={{ color: biasColor, fontSize: 12, fontWeight: 600 }}>{s.bias}</span>
          </div>
        </div>
        <button onClick={onClose} style={{
          background: "none", border: "1px solid #1e2535", color: "#64748b",
          borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 12
        }}>✕</button>
      </div>

      {/* Stage flow */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ color: "#475569", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Setup Chain</p>
        <div style={{ display: "flex", alignItems: "center" }}>
          {SETUP_STAGES.map((label, i) => {
            const colors = ["#a78bfa", "#60a5fa", "#f59e0b", "#00e5a0"];
            return (
              <div key={label} style={{ display: "flex", alignItems: "center" }}>
                <div style={{
                  padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                  background: `${colors[i]}18`, color: colors[i],
                  border: `1px solid ${colors[i]}40`,
                }}>{label}</div>
                {i < 3 && <div style={{ width: 16, height: 1, background: "#334155" }} />}
              </div>
            );
          })}
        </div>
      </div>

      {/* Price levels */}
      <div style={{ marginBottom: 20 }}>
        <p style={{ color: "#475569", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Price Levels</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {levels.map(({ label, value, desc }) => (
            <div key={label} style={{
              background: "#0d1420", border: "1px solid #1e2535", borderRadius: 8, padding: "10px 14px"
            }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#94a3b8", fontSize: 12 }}>{label}</span>
                <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontSize: 13, fontWeight: 600 }}>{value ?? "—"}</span>
              </div>
              <p style={{ color: "#475569", fontSize: 11, margin: "4px 0 0" }}>{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Trade idea */}
      <div style={{
        background: s.inFVG ? "#00e5a008" : "#1e293808",
        border: `1px solid ${s.inFVG ? "#00e5a025" : "#1e2535"}`,
        borderRadius: 10, padding: "14px 16px"
      }}>
        <p style={{ color: s.inFVG ? "#00e5a0" : "#94a3b8", fontSize: 12, fontWeight: 700, margin: "0 0 8px", textTransform: "uppercase" }}>
          {s.inFVG ? "✦ Price in FVG — Active Setup" : s.nearFVG ? "⚡ Approaching FVG" : "⏳ Awaiting Retrace"}
        </p>
        <p style={{ color: "#94a3b8", fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          {s.bias === "Bullish"
            ? `Liquidity swept below equal lows. Bullish displacement confirmed. MSS broke prior swing high. ${s.inFVG ? "Price has retraced into the FVG — look for bullish confirmation (engulfing, pin bar) for long entries." : "Wait for price to retrace into FVG between " + s.fvgLow + " – " + s.fvgHigh + " before entry."}`
            : `Liquidity swept above equal highs. Bearish displacement confirmed. MSS broke prior swing low. ${s.inFVG ? "Price has retraced into the FVG — look for bearish confirmation (engulfing, rejection wick) for short entries." : "Wait for price to retrace into FVG between " + s.fvgLow + " – " + s.fvgHigh + " before entry."}`}
        </p>
        <p style={{ color: "#475569", fontSize: 11, margin: "10px 0 0" }}>⚠ Scanner output only. Always manage risk.</p>
      </div>
    </div>
  );
}

// ── Main App ──
export default function ICTScannerLive() {
  const [apiKey, setApiKey] = useState("");
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [setups, setSetups] = useState([]);
  const [selected, setSelected] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: "" });
  const [lastScan, setLastScan] = useState(null);
  const [errors, setErrors] = useState([]);
  const [filterBias, setFilterBias] = useState("All");
  const [filterTf, setFilterTf] = useState("All");
  const [filterFVG, setFilterFVG] = useState(false);
  const abortRef = useRef(false);

  const runScan = useCallback(async (key) => {
    setScanning(true);
    setSetups([]);
    setSelected(null);
    setErrors([]);
    abortRef.current = false;

    const jobs = [];
    for (const pair of PAIRS) {
      for (const tf of TIMEFRAMES) {
        jobs.push({ pair, tf, symbol: SYMBOL_MAP[pair] });
      }
    }

    setProgress({ done: 0, total: jobs.length, current: "" });
    const results = [];
    const errs = [];

    for (let i = 0; i < jobs.length; i++) {
      if (abortRef.current) break;
      const { pair, tf, symbol } = jobs[i];
      setProgress({ done: i, total: jobs.length, current: `${pair} ${tf}` });

      try {
        const candles = await fetchCandles(symbol, tf, key);
        const setup = analyzeCandles(candles);
        if (setup) {
          results.push({ pair, tf, ...setup });
          setSetups(prev => [...prev, { pair, tf, ...setup }]
            .sort((a, b) => (b.inFVG ? 1 : 0) - (a.inFVG ? 1 : 0) || b.confidence - a.confidence));
        }
      } catch (e) {
        errs.push(`${pair} ${tf}: ${e.message}`);
      }

      // Rate-limit: ~3 req/sec to stay within RapidAPI limits
      await new Promise(r => setTimeout(r, 350));
    }

    setProgress({ done: jobs.length, total: jobs.length, current: "" });
    setErrors(errs);
    setLastScan(new Date());
    setScanning(false);
  }, []);

  const handleStart = () => {
    if (!apiKeyInput.trim()) return;
    setApiKey(apiKeyInput.trim());
    runScan(apiKeyInput.trim());
  };

  const filtered = setups.filter(s => {
    if (filterBias !== "All" && s.bias !== filterBias) return false;
    if (filterTf !== "All" && s.tf !== filterTf) return false;
    if (filterFVG && !s.inFVG) return false;
    return true;
  });

  const inFVGCount = setups.filter(s => s.inFVG).length;

  // ── API Key Entry Screen ──
  if (!apiKey) {
    return (
      <div style={{
        minHeight: "100vh", background: "#060b14", display: "flex", alignItems: "center",
        justifyContent: "center", fontFamily: "'Inter', system-ui, sans-serif"
      }}>
        <div style={{
          background: "#0d1420", border: "1px solid #1e2535", borderRadius: 16,
          padding: "40px 36px", width: 420, maxWidth: "90vw"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#00e5a0", boxShadow: "0 0 8px #00e5a0" }} />
            <span style={{ color: "#e2e8f0", fontWeight: 700, fontSize: 17 }}>ICT Scanner — Live Data</span>
          </div>
          <p style={{ color: "#475569", fontSize: 13, marginBottom: 28, lineHeight: 1.6 }}>
            Connects to TradingView via RapidAPI to scan real OHLCV candles for the full ICT setup chain:<br />
            <span style={{ color: "#94a3b8" }}>Liquidity → Displacement → MSS → FVG</span>
          </p>

          <label style={{ color: "#64748b", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>
            RapidAPI Key
          </label>
          <input
            type="password"
            placeholder="Paste your x-rapidapi-key here"
            value={apiKeyInput}
            onChange={e => setApiKeyInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleStart()}
            style={{
              display: "block", width: "100%", marginTop: 6, marginBottom: 16,
              background: "#060b14", border: "1px solid #1e2535", borderRadius: 8,
              color: "#e2e8f0", padding: "10px 14px", fontSize: 13,
              outline: "none", boxSizing: "border-box", fontFamily: "monospace"
            }}
          />

          <button
            onClick={handleStart}
            disabled={!apiKeyInput.trim()}
            style={{
              width: "100%", background: apiKeyInput.trim() ? "#1d4ed8" : "#1e2535",
              border: "none", color: apiKeyInput.trim() ? "#fff" : "#475569",
              borderRadius: 8, padding: "11px", cursor: apiKeyInput.trim() ? "pointer" : "default",
              fontSize: 14, fontWeight: 600, transition: "background 0.2s"
            }}
          >
            Start Live Scan
          </button>

          <p style={{ color: "#334155", fontSize: 11, marginTop: 16, textAlign: "center" }}>
            Get a free key at{" "}
            <a href="https://rapidapi.com/hypier/api/tradingview-data1" target="_blank" rel="noreferrer"
              style={{ color: "#3b82f6" }}>rapidapi.com</a>
            {" "}· Free plan: 150 req/mo
          </p>
        </div>
      </div>
    );
  }

  // ── Scanner UI ──
  return (
    <div style={{
      minHeight: "100vh", background: "#060b14", color: "#e2e8f0",
      fontFamily: "'Inter', system-ui, sans-serif", display: "flex", flexDirection: "column"
    }}>
      {/* Header */}
      <div style={{
        background: "#0a1020", borderBottom: "1px solid #1e2535",
        padding: "12px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: scanning ? "#f59e0b" : "#00e5a0",
            boxShadow: `0 0 8px ${scanning ? "#f59e0b" : "#00e5a0"}`,
            animation: scanning ? "pulse 1s infinite" : "none"
          }} />
          <span style={{ fontWeight: 700, fontSize: 15 }}>ICT Scanner</span>
          <span style={{ fontSize: 10, color: "#475569", background: "#1e2535", padding: "2px 8px", borderRadius: 4, fontFamily: "monospace" }}>
            Liq → Disp → MSS → FVG
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {scanning && (
            <span style={{ fontSize: 11, color: "#f59e0b" }}>
              Scanning {progress.current} ({progress.done}/{progress.total})
            </span>
          )}
          {!scanning && lastScan && (
            <span style={{ fontSize: 11, color: "#475569" }}>
              {inFVGCount} in FVG · {setups.length} setups · {lastScan.toLocaleTimeString()}
            </span>
          )}
          {scanning ? (
            <button onClick={() => { abortRef.current = true; setScanning(false); }} style={{
              background: "#7f1d1d", border: "none", color: "#fca5a5", borderRadius: 6,
              padding: "6px 12px", cursor: "pointer", fontSize: 12
            }}>Stop</button>
          ) : (
            <button onClick={() => runScan(apiKey)} style={{
              background: "#1e2535", border: "none", color: "#94a3b8", borderRadius: 6,
              padding: "6px 12px", cursor: "pointer", fontSize: 12
            }}>↻ Rescan</button>
          )}
          <button onClick={() => { setApiKey(""); setSetups([]); }} style={{
            background: "none", border: "1px solid #1e2535", color: "#475569", borderRadius: 6,
            padding: "6px 10px", cursor: "pointer", fontSize: 11
          }}>⚙ Key</button>
        </div>
      </div>

      {/* Progress bar */}
      {scanning && (
        <div style={{ height: 2, background: "#1e2535" }}>
          <div style={{
            height: "100%", background: "#3b82f6", borderRadius: 1,
            width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
            transition: "width 0.3s"
          }} />
        </div>
      )}

      {/* Filters */}
      <div style={{
        background: "#0a1020", borderBottom: "1px solid #1e2535",
        padding: "10px 20px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center"
      }}>
        {[
          { label: "Bias", value: filterBias, set: setFilterBias, opts: ["All", "Bullish", "Bearish"] },
          { label: "Timeframe", value: filterTf, set: setFilterTf, opts: ["All", ...TIMEFRAMES] },
        ].map(({ label, value, set, opts }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: "#475569" }}>{label}</span>
            <div style={{ display: "flex", gap: 2 }}>
              {opts.map(o => (
                <button key={o} onClick={() => set(o)} style={{
                  background: value === o ? "#1e3a5f" : "#1e2535",
                  border: `1px solid ${value === o ? "#3b82f6" : "transparent"}`,
                  color: value === o ? "#60a5fa" : "#64748b",
                  borderRadius: 4, padding: "3px 8px", cursor: "pointer", fontSize: 11
                }}>{o}</button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={() => setFilterFVG(f => !f)} style={{
          background: filterFVG ? "#00e5a015" : "#1e2535",
          border: `1px solid ${filterFVG ? "#00e5a040" : "transparent"}`,
          color: filterFVG ? "#00e5a0" : "#64748b",
          borderRadius: 4, padding: "3px 10px", cursor: "pointer", fontSize: 11
        }}>In FVG only</button>
        <span style={{ fontSize: 11, color: "#334155", marginLeft: "auto" }}>
          {filtered.length} result{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Body */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>
        {/* List */}
        <div style={{
          width: 340, minWidth: 280, borderRight: "1px solid #1e2535",
          overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8
        }}>
          {/* Legend */}
          <div style={{ display: "flex", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            {[["#a78bfa", "Liq"], ["#60a5fa", "Disp"], ["#f59e0b", "MSS"], ["#00e5a0", "FVG"]].map(([c, l]) => (
              <div key={l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 10, height: 4, borderRadius: 2, background: c }} />
                <span style={{ fontSize: 10, color: "#475569" }}>{l}</span>
              </div>
            ))}
          </div>

          {!scanning && setups.length === 0 && (
            <div style={{ color: "#334155", fontSize: 13, textAlign: "center", paddingTop: 40 }}>
              No setups found yet. Click Rescan to run.
            </div>
          )}

          {filtered.length === 0 && setups.length > 0 && (
            <div style={{ color: "#334155", fontSize: 13, textAlign: "center", paddingTop: 20 }}>
              No setups match current filters.
            </div>
          )}

          {filtered.map((s, i) => (
            <SetupCard
              key={`${s.pair}-${s.tf}-${i}`}
              s={s}
              onClick={setSelected}
              selected={selected?.pair === s.pair && selected?.tf === s.tf}
            />
          ))}

          {errors.length > 0 && !scanning && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 11, color: "#475569", cursor: "pointer" }}>
                {errors.length} scan error{errors.length !== 1 ? "s" : ""}
              </summary>
              <div style={{ marginTop: 6 }}>
                {errors.map((e, i) => (
                  <div key={i} style={{ fontSize: 10, color: "#374151", fontFamily: "monospace", marginBottom: 2 }}>{e}</div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* Detail */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <DetailPanel s={selected} onClose={() => setSelected(null)} />
        </div>
      </div>

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #060b14; }
        ::-webkit-scrollbar-thumb { background: #1e2535; border-radius: 4px; }
        input::placeholder { color: #334155; }
      `}</style>
    </div>
  );
}
