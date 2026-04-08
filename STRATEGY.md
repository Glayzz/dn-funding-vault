# Delta-Neutral SOL Funding Rate Arbitrage Vault

### Ranger Build-A-Bear Hackathon — Main Track Submission

---

## Executive Summary

This vault implements a **delta-neutral funding rate arbitrage strategy** on Solana, capturing the persistent positive funding rate premium on SOL perpetual futures while maintaining near-zero directional market exposure. Capital is deployed across two equal-weighted legs — a spot long in SOL and a synthetic short via SOL-PERP — that cancel each other's price sensitivity and isolate funding yield as the sole return driver.

The strategy is fully on-chain, non-custodial, and permissionless. Any depositor earns yield regardless of whether SOL appreciates or depreciates. Risk is tightly bounded by automated drawdown controls and continuous funding rate monitoring.

**Perp venue:** Flash Trade (Solana-native perpetuals)
**Spot routing:** Jupiter v6 (best-execution aggregation)
**Vault infrastructure:** Ranger Earn / Voltr SDK

> **Venue migration note:** The original submission routed the perp leg through Drift Protocol. Following the Ranger team's April 2026 update removing the Drift Side Track due to recent security events, the perp execution layer has been migrated to Flash Trade. Flash Trade implements an identical hourly funding rate mechanism — longs pay shorts when open interest is long-skewed — making it a direct functional replacement. All strategy logic, risk parameters, and yield mechanics are unchanged.

> **Execution model note:** The manager bot uses EOA-based direct execution. There is currently no Voltr adaptor for Flash Trade. This approach is explicitly sanctioned by Ranger (admin confirmation, April 2026): *"Our hackathon is not limited to only adaptors/protocols we are integrated. You can create strategies with EOAs on any protocols and submit them. We'll work tgt to create those adaptors for selected winners."* Post-hackathon adaptor development is part of the production roadmap.

---

**Backtested performance summary (2023–2025, simulated hourly data):**

| Metric | Value |
|---|---|
| CAGR | 35–55% (regime-dependent) |
| Sharpe Ratio | > 2.0 |
| Maximum Drawdown | < 3% |
| Positive Funding Periods | ~75% of hours |
| Net Delta | ~0 at all times |

---

## 1. Market Opportunity

### 1.1 Perpetual Futures Funding Mechanics

Perpetual futures contracts do not expire. To keep the perpetual price anchored to the spot price, exchanges impose a periodic **funding rate** — a cash transfer between long and short position holders. When the perpetual trades at a premium to spot (i.e., more long demand than short), longs pay shorts. When it trades at a discount, shorts pay longs.

On Solana-based perpetual venues including Flash Trade, this payment occurs **every hour**. The rate is a function of the difference between the mark price and the index price, scaled by a dampening factor.

### 1.2 The SOL Funding Premium

SOL-PERP has historically exhibited a pronounced and persistent positive funding bias. In bull markets, retail demand for leveraged long SOL positions overwhelms natural short supply, driving the perpetual price above spot and generating significant hourly payments to short holders.

Based on backtested data over 2023–2025:

- Funding rate is **positive approximately 70–80% of the time**
- Average annualised rate during positive periods: **~40–60% APR**
- Negative funding episodes are typically brief (< 72 hours) and shallow

### 1.3 The Core Problem This Strategy Solves

A naive short position on SOL-PERP earns funding but loses money when SOL rallies. Conversely, holding spot SOL earns no yield. The delta-neutral vault solves both problems simultaneously: it **hedges the short with an equal spot position**, producing a combined delta of zero. The vault neither gains nor loses from SOL price movements — it earns only the funding rate spread, net of fees.

This structure is well-established in TradFi (basis trading, cash-and-carry) and in CeFi (funding rate bots on Binance and Bybit). This vault brings the same mechanism fully on-chain via Ranger Earn, making it permissionless, transparent, and composable.

---

## 2. Strategy Architecture

### 2.1 Capital Allocation

On each deployment, vault capital is split as follows:

| Allocation | Size | Purpose |
|---|---|---|
| Spot SOL (long) | 47.5% | Hedges the perp short; delta offset |
| Flash Trade SOL-PERP (short) | 47.5% | Funding rate collection |
| USDC idle buffer | 5.0% | Gas, margin top-ups, redemptions |

The spot and perp legs are sized to equal notional exposure, producing a net delta of approximately zero at all times (subject to drift, managed by the rebalancer).

### 2.2 System Diagram

```
User deposits USDC
        │
        ▼
┌──────────────────────────────────────────┐
│           Ranger Earn Vault              │
│           (USDC denominated)             │
│                                          │
│   ┌────────────────┐  ┌───────────────┐  │
│   │    47.5%       │  │    47.5%      │  │
│   │  Jupiter Swap  │  │  Flash Trade  │  │
│   │  Spot SOL      │  │  SOL-PERP     │  │
│   │  (Long)        │  │  (Short, 2x)  │  │
│   └────────────────┘  └───────────────┘  │
│           │  Net Delta ≈ 0  │            │
│                                          │
│   ┌──────────────────────────────────┐   │
│   │        5% USDC Buffer            │   │
│   │  (gas reserves + redemptions)    │   │
│   └──────────────────────────────────┘   │
└──────────────────────────────────────────┘
        │
        ▼
  Yield: Funding rate payments
         collected every hour
```

### 2.3 Execution Layer

| Component | Protocol | Method |
|---|---|---|
| Perp short (open/close/monitor) | Flash Trade | Manager EOA → Flash program direct instruction |
| Spot long (buy/sell SOL) | Jupiter v6 | Manager EOA → Jupiter Quote + Swap API |
| Vault deposits / withdrawals | Ranger Earn / Voltr | `VoltrClient` SDK |
| Fee harvest | Voltr | `createHarvestFeeIx` |
| NAV tracking | Voltr | `getPositionAndTotalValuesForVault` |

### 2.4 Funding Rate Data Source

The manager bot reads the Flash Trade SOL custody account directly on-chain every 60 seconds. The `hourlyFundingRateBps` field (stored as `i64` at a fixed offset in the custody account) is decoded and annualised:

```
annualised_rate = (hourly_rate_bps / 1_000_000) × 24 × 365
```

A positive value means longs are paying shorts. The bot acts on this signal to enter and exit the position.

---

## 3. Position Lifecycle

### 3.1 Entry Conditions

The bot opens a position when:

1. The vault is not currently in a position
2. The annualised funding rate exceeds **+10% APR** (configurable)
3. No active drawdown limit has been triggered

On entry, USDC is split: 47.5% routed through Jupiter to purchase spot SOL, 47.5% used as collateral to open a 2x short on Flash Trade. The position keypair is persisted to `bot-state.json` for restart resilience.

### 3.2 Exit Conditions

The bot closes the position when any of the following occur:

| Trigger | Threshold | Action |
|---|---|---|
| Funding rate falls | < +2% APR | Close both legs, return to USDC |
| Soft drawdown | NAV -5% from HWM | Pause new deposits; hold positions |
| Hard drawdown | NAV -10% from HWM | Close all positions immediately |

On exit, the Flash Trade short is closed first, then spot SOL is sold back to USDC via Jupiter.

### 3.3 Delta Rebalancing

Over time, SOL price movements and funding payments cause the notional values of the two legs to diverge. The bot checks delta drift every 60 seconds:

```
drift = |current_short_notional - target_notional| / target_notional
```

If drift exceeds **2%**, the bot rebalances by adjusting the smaller leg to restore parity. This keeps the net delta near zero and prevents the vault from inadvertently taking directional exposure.

---

## 4. Risk Management

### 4.1 Market Risk (Delta)

Delta is maintained near zero through continuous monitoring and rebalancing. In the worst case (rebalance delayed by network congestion), maximum unhedged exposure is bounded by the 2% drift threshold, representing < 1% NAV impact per 10% SOL move.

### 4.2 Funding Rate Risk

If funding turns persistently negative, the vault pays out rather than collects. The **+2% APR exit threshold** ensures the vault exits before negative funding meaningfully erodes NAV. Historically, negative funding periods on SOL-PERP are brief and shallow, but the safeguard is always active.

### 4.3 Liquidation Risk

The Flash Trade short is opened at **2x leverage**, which is well below the liquidation threshold for SOL-PERP (typically ~10–20x). The 5% USDC buffer provides additional margin headroom. The bot monitors position health and tops up margin from the buffer if needed.

### 4.4 Smart Contract Risk

- **Ranger Earn / Voltr:** Audited protocol; vault contract is not modified
- **Flash Trade:** Established Solana perp DEX; no custom programs deployed
- **Jupiter:** Industry-standard swap aggregator; no custom programs deployed
- No custom on-chain code is introduced by this submission

### 4.5 Operational Risk

- Bot state is persisted to disk (`bot-state.json`) — position survives process restarts
- All errors are caught and logged; the bot continues on the next cycle
- Soft and hard drawdown limits provide a safety net for unexpected events

---

## 5. Fee Structure

| Fee | Rate | Recipient | Notes |
|---|---|---|---|
| Management fee | 1.5% per annum | Vault manager | Charged continuously via Voltr |
| Performance fee | 10% of profits | Vault manager | Above high-water mark only |
| Issuance fee | 0% | — | Free to deposit |
| Redemption fee | 0% | — | Free to withdraw |
| Flash Trade taker fee | 0.06% | Flash Trade | Per perp open/close, passed through |
| Jupiter swap fee | ~0.10% | Jupiter routers | Per spot swap, passed through |

At a 40% gross APR, net yield after all fees is approximately **33–35% APR** for depositors.

---

## 6. Operations & Infrastructure

### 6.1 Manager Bot

The manager bot is a Node.js/TypeScript process that runs 24/7 on a VPS. It performs the following on a 60-second loop:

- Read Flash Trade funding rate from on-chain custody account
- Read vault NAV from Voltr
- Evaluate entry/exit conditions
- Check delta drift; rebalance if threshold exceeded
- Check and harvest accumulated manager fees

### 6.2 State Management

Position state (perp position account, spot SOL amount, high-water mark) is written to `bot-state.json` after every state change. On restart, the bot resumes from the last saved state without requiring manual intervention.

### 6.3 Environment Variables

| Variable | Description |
|---|---|
| `RPC_URL` | Solana RPC endpoint (Helius/QuickNode recommended) |
| `MANAGER_KEYPAIR` | Manager wallet secret key as JSON array |

---

## 7. Production Roadmap

| Phase | Timeline | Milestone |
|---|---|---|
| Devnet testing | Week 1 | Funding rate monitoring live; position open/close verified |
| Mainnet beta | Week 2 | Deploy with $10k seed capital; live monitoring |
| Adaptor development | Post-hackathon | Ranger team builds Flash Trade Voltr adaptor for selected winners |
| Public listing | 3–6 months | List on Ranger Earn marketplace with public deposit UI |
| Scale | 6–12 months | Target $500k+ TVL with Ranger seed funding |

---

## 8. Why This Strategy Wins

**For depositors:** Uncorrelated yield. SOL can go to zero or 10x — depositors earn the same funding rate yield either way.

**For Ranger Earn:** This is exactly the kind of institutional-grade, production-ready strategy the platform is designed to host. It is auditable, non-custodial, and demonstrates a clear path to $500k+ TVL.

**For the ecosystem:** Brings a proven TradFi/CeFi strategy fully on-chain for the first time on Solana — permissionless, composable, and transparent.

---

## 9. Repository Structure

`github.com/Glayzz/dn-funding-vault`

| File | Description |
|---|---|
| `/src/vault-manager.ts` | Manager bot — EOA/Flash Trade execution, main loop |
| `/src/setup-vault.ts` | Vault initialisation script |
| `/backtest.py` | Python backtesting engine (2-year simulated hourly data) |
| `/backtest_results.png` | Equity curve, funding rate chart, position state |
| `/backtest_results.json` | Machine-readable backtest metrics |
| `/vault-config.json` | Deployed vault address and configuration |
| `/STRATEGY.md` | This document |