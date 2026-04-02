# DN Funding Rate Vault

**Delta-Neutral SOL Funding Rate Arbitrage Vault**
Built for the Ranger Build-A-Bear Hackathon 2026 — Main Track + Drift Side Track

---

## Overview

This vault captures SOL-PERP funding rate payments on Drift Protocol while maintaining zero net market exposure. It holds equal long spot SOL and short SOL-PERP positions, making returns entirely independent of SOL price direction.

**Live Vault Address (Solana Mainnet):**
`88jtDH1zGT4DCJtQveLeUAEhoHgjtdRB8twUFSSMAKBm`

---

## 1. Strategy Thesis

Perpetual futures traders pay a funding rate every hour to maintain their positions. On Drift Protocol, SOL-PERP has historically been positive-funded ~70% of the time, with annualised rates ranging from 30% to over 120% during bull regimes.

This vault systematically captures those payments by:
- Holding 47.5% of capital as **long spot SOL** (via Jupiter)
- Holding 47.5% as a **short SOL-PERP position** (via Drift Protocol)
- Keeping 5% idle in **USDC** for gas and redemptions

Net delta = 0. The vault earns funding regardless of price direction.

## Strategy Architecture

```
User deposits USDC
        │
        ▼
┌─────────────────────────────┐
│   Ranger Earn Vault         │
│   (USDC denominated)        │
│                             │
│  ┌─────────┐  ┌──────────┐  │
│  │ 47.5%   │  │  47.5%   │  │
│  │ Spot    │  │  Drift   │  │
│  │ SOL     │  │  SOL-PERP│  │
│  │ (Long)  │  │  (Short) │  │
│  └─────────┘  └──────────┘  │
│        ↑ Delta-neutral ↑    │
│                             │
│  ┌─────────────────────┐    │
│  │   5% USDC Buffer    │    │
│  │ (gas + redemptions) │    │
│  └─────────────────────┘    │
└─────────────────────────────┘
```

---

## 2. How It Operates on Ranger Earn

The vault is initialized using the **Ranger Earn SDK** (`@voltr/vault-sdk`) with:
- **Drift Protocol Adaptor** for the perpetual short
- **Jupiter Adaptor** for the spot long swap
- A **TypeScript manager bot** running on a VPS with 60-second polling

The bot:
- Monitors the funding rate every 60 seconds
- Auto-rebalances when net delta drifts beyond ±2%
- Exits the perp short if annualised funding drops below 2% APR
- Harvests management and performance fees automatically

---

## 3. Risk Management

| Layer | Threshold | Action |
|-------|-----------|--------|
| Delta control | ±2% drift | Auto-rebalance immediately |
| Funding threshold | <2% APR | Exit perp position |
| Leverage cap | 2× max | Hard-coded limit on Drift |
| Soft circuit breaker | 5% NAV drawdown | Pause new deposits |
| Hard circuit breaker | 10% NAV drawdown | Close all positions, return to USDC |
| Buffer reserve | 5% USDC always idle | Gas costs + instant redemptions |

### 3.1 Delta Management
The vault rebalances when net delta drifts beyond ±2% of target. This can occur due to:
- Funding rate payments changing the short notional
- SOL price movement affecting the relative weight

**Rebalancing trigger:** `|current_short_notional - target| / target > 2%`

### 3.2 Negative Funding Protection
The bot monitors the 1-hour funding rate continuously. If the annualised rate drops below **+2% APR**, the perp short is reduced or closed, preventing the vault from paying funding instead of earning it.

Exit condition: `hourly_rate × 24 × 365 < 0.02`

### 3.3 Drawdown Limits
- **Soft limit:** If vault NAV drops >5% from high-water mark, pause new deposits and reduce leverage
- **Hard limit:** If vault NAV drops >10% from high-water mark, close all positions and sit in USDC

### 3.4 Liquidation Protection
- Maximum leverage on Drift short: **2x** (well above liquidation threshold)
- Idle buffer maintained at 5% for margin top-ups if needed
- Health factor monitoring via Drift account data

### 3.5 Smart Contract Risk
- Ranger Earn is audited (see Ranger security docs)
- Drift Protocol is one of Solana's most battle-tested venues (>$500M TVL)
- No custom on-chain programs — vault uses existing, audited adaptors only

Zero custom smart contracts. Only audited Ranger Earn and Drift Protocol infrastructure.

---

## 4. Backtest Results (2023–2025)

- **CAGR:** 35.1%
- **Sharpe Ratio:** 48.88
- **Max Drawdown:** 0.5%
- **Total Return:** 82.6% ($100K → $182,602)
- **Data Points:** 17,520 hourly observations
- **Total Trades:** 30 rebalancing events over 2 years
- **Fees applied:** 1.5% annual management fee + 10% performance fee + realistic swap/perp costs

See `backtest_results.png` for full equity curve, funding rate chart, and position state visualization.

---

## 5. Deployment

The vault was built and deployed during the hackathon window (March 9 – April 6, 2026):

- **Strategy research and backtest development** — funding rate data analysis, regime simulation
- **Mainnet deployment** — vault initialized on Solana Mainnet Beta using Ranger Earn SDK
- **Adaptor integration** — Drift Protocol adaptor and Jupiter adaptor configured
- **Manager bot deployed** — TypeScript bot running on VPS with live monitoring
- **Post-hackathon roadmap** — Scale to full TVL with Ranger seed funding, list on Ranger Earn public marketplace

---

## 6. Comparable Strategies

This strategy is well-validated in TradFi (basis trading) and CeFi (funding rate bots on Binance/Bybit). What makes this novel:

- Fully **on-chain and non-custodial** via Ranger Earn
- **Publicly auditable positions** — all trades verifiable on Solana Explorer
- **Permissionless deposits** — anyone can allocate capital
- **Zero counterparty risk** — no CEX dependency

---


## 7. Fee Structure

| Fee | Rate | Notes |
|-----|------|-------|
| Management fee | 1.5% annually | Charged continuously, accrues to manager |
| Performance fee | 10% | On profits above high-water mark |
| Entry/exit | 0% | No redemption or issuance fee |
| Drift taker fee | 0.06% | Per perp trade (passed through) |
| Jupiter swap fee | ~0.10% | Per spot swap (passed through) |

---

## 8. Repository Structure

```
dn-funding-vault/
├── src/
│   ├── vault-manager.ts     # Manager bot (60s polling, auto-rebalance, harvest)
│   └── setup-vault.ts       # Vault initialization script
├── backtest.py              # Python backtesting engine
├── backtest_results.png     # Equity curve + funding rate chart
├── backtest_results.json    # Raw backtest output data
├── vault-config.json        # On-chain vault configuration (mainnet)
├── STRATEGY.md              # Full strategy documentation
└── README.md                # This file
```

---

*Built by Glayzz for Ranger Build-A-Bear Hackathon 2026*
*Vault: 88jtDH1zGT4DCJtQveLeUAEhoHgjtdRB8twUFSSMAKBm*
