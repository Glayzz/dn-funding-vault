# DN Funding Rate Vault

**Delta-Neutral SOL Funding Rate Arbitrage Vault**
Built for the Ranger Build-A-Bear Hackathon 2026 — Main Track

---

## Overview

This vault captures SOL perpetual futures funding rate payments on Flash Trade while maintaining zero net market exposure. It holds equal long spot SOL and short SOL-PERP positions — depositors earn uncorrelated yield regardless of SOL price direction.

**Live Vault Address (Solana Mainnet):**
`88jtDH1zGT4DCJtQveLeUAEhoHgjtdRB8twUFSSMAKBm`

**Perp venue:** Flash Trade · **Spot routing:** Jupiter v6 · **Vault infrastructure:** Ranger Earn

> **Venue note:** The original submission used Drift Protocol for the perp leg. Following the April 2026 security incident, the perp execution layer has been migrated to Flash Trade — an established Solana-native perp DEX with an identical hourly funding rate mechanism. All strategy logic and risk parameters are unchanged.

> **Execution note:** The manager bot uses EOA-based direct execution against Flash Trade's on-chain program. No Voltr adaptor for Flash Trade currently exists. This approach is explicitly sanctioned by Ranger: *"Our hackathon is not limited to only adaptors/protocols we are integrated. You can create strategies with EOAs on any protocols and submit them. We'll work tgt to create those adaptors for selected winners."* — Shayn, Ranger admin, April 2026.

---

## Performance

Backtested on two years of hourly funding rate data (2023–2025), calibrated to match observed on-chain distributions for SOL-PERP.

| Metric | Result |
|---|---|
| CAGR | 35–55% *(funding regime dependent)* |
| Sharpe Ratio | > 2.0 |
| Maximum Drawdown | < 3% |
| Volatility | < 2% annualised |
| Net Delta | ≈ 0 at all times |
| Positive Funding Periods | ~75% of all hours |

![Equity Curve & Funding Rate Chart](backtest_results.png)

Full backtest metrics in [`backtest_results.json`](./backtest_results.json). Methodology in [`backtest.py`](./backtest.py).

> **Note on minimum APY requirement:** The vault targets 35–55% CAGR — well above the 10% minimum. The current live rate reflects market conditions. The bot only deploys capital when funding exceeds +10% APR and exits when it falls below +2% APR — this selective deployment is why the backtest achieves strong risk-adjusted returns across both bull and bear regimes.

---

## How It Works

### Capital Allocation

| Bucket | Allocation | Protocol | Purpose |
|---|---|---|---|
| Spot SOL (long) | 47.5% | Jupiter Swap | Delta hedge against the perp short |
| SOL-PERP (short) | 47.5% | Flash Trade | Funding rate collection |
| USDC buffer | 5.0% | Idle | Gas reserves, margin top-ups, redemptions |

### Position Lifecycle

**Entry** — Bot opens when annualised Flash Trade funding rate exceeds **+10% APR**. USDC is split: 47.5% → spot SOL via Jupiter, 47.5% → 2x SOL-PERP short on Flash Trade.

**Holding** — Every 60 seconds the bot reads funding rate from Flash Trade's SOL custody account on-chain. Funding payments accumulate to vault NAV. Delta drift checked against 2% threshold and rebalanced automatically.

**Exit** — Bot closes when annualised rate falls below **+2% APR**. Both legs unwound: Flash Trade short closed first, then spot SOL sold back to USDC via Jupiter.

---

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Ranger Earn Vault             │
                    │          (USDC denominated)             │
                    │                                         │
  User deposits ───►│  ┌──────────────┐   ┌───────────────┐  │
      USDC          │  │    47.5%     │   │    47.5%      │  │
                    │  │  Spot SOL    │   │  Flash Trade  │  │
                    │  │  via Jupiter │   │  SOL-PERP     │  │
                    │  │  (Long)      │   │  (Short, 2x)  │  │
                    │  └──────────────┘   └───────────────┘  │
                    │        │    Net Delta ≈ 0   │           │
                    │  ┌─────────────────────────────────┐   │
                    │  │        5% USDC Buffer            │   │
                    │  │  Gas · Margin · Redemptions      │   │
                    │  └─────────────────────────────────┘   │
                    └─────────────────────────────────────────┘
                                       │
                                       ▼
                         Yield: hourly funding payments
                         collected from long position holders
```

### Component Responsibilities

| Component | Protocol | Interaction |
|---|---|---|
| Vault accounting, deposits, withdrawals | Ranger Earn · Voltr | `VoltrClient` SDK |
| Perp short — open, hold, close | Flash Trade | Manager EOA → Flash program |
| Spot long — buy/sell SOL | Jupiter | Manager EOA → Jupiter v6 API |
| Funding rate data | Flash Trade | On-chain custody account read (60s) |
| Fee harvest | Voltr | `createHarvestFeeIx` |
| NAV tracking | Voltr | `getPositionAndTotalValuesForVault` |

---

## Risk Management

| Layer | Threshold | Action |
|---|---|---|
| Delta control | ±2% drift | Auto-rebalance immediately |
| Entry threshold | >10% APR | Open position |
| Exit threshold | <2% APR | Close position |
| Leverage cap | 2× max | Hard-coded on Flash Trade |
| Soft circuit breaker | −5% NAV from HWM | Pause new deposits |
| Hard circuit breaker | −10% NAV from HWM | Close all positions, return to USDC |
| Buffer reserve | 5% USDC always idle | Gas + margin + redemptions |

Bot state is persisted to `bot-state.json` after every state transition — the bot resumes from last known state on restart without manual intervention.

Zero custom smart contracts. Only audited Ranger Earn, Flash Trade, and Jupiter infrastructure.

---

## Fee Structure

| Fee | Rate | Notes |
|---|---|---|
| Management fee | 1.5% per annum | Charged continuously via Voltr |
| Performance fee | 10% of profits | Above high-water mark only |
| Entry/exit | 0% | No redemption or issuance fee |
| Flash Trade taker fee | 0.06% per trade | Passed through |
| Jupiter swap fee | ~0.10% per swap | Passed through |

At 40% gross funding APR — estimated net depositor yield: **~33–35% APR**.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- Funded Solana wallet for manager EOA
- Provisioned Ranger Earn vault (see `vault-config.json`)

### Installation

```bash
git clone https://github.com/Glayzz/dn-funding-vault
cd dn-funding-vault
npm install
```

### Configuration

```bash
export RPC_URL="https://your-rpc-endpoint"       # Helius or QuickNode recommended
export MANAGER_KEYPAIR='[1,2,3,...]'             # Manager wallet secret key as JSON array
```

### Running the Manager Bot

```bash
# Mainnet
RPC_URL=https://your-mainnet-rpc npx ts-node src/vault-manager.ts
```

The bot logs status every 60 seconds and writes position state to `bot-state.json`.

---

## Project Structure

```
dn-funding-vault/
├── src/
│   ├── vault-manager.ts       # Manager bot — main loop, EOA/Flash Trade execution
│   └── setup-vault.ts         # Vault initialisation script
├── backtest.py                # Python backtesting engine
├── backtest_results.json      # Machine-readable backtest metrics
├── backtest_results.png       # Equity curve, funding rate chart, position state
├── bot-state.json             # Persisted bot state (position, HWM)
├── vault-config.json          # Deployed vault address and configuration
├── STRATEGY.md                # Full strategy documentation and risk analysis
├── package.json
└── tsconfig.json
```

---

## Tech Stack

**Language:** TypeScript · Node.js · **Vault SDK:** `@voltr/vault-sdk`
**Perp venue:** Flash Trade · **Spot:** Jupiter v6 · **Network:** Solana Mainnet

---

*For full strategy documentation, market analysis, and post-hackathon roadmap, see [STRATEGY.md](./STRATEGY.md).*

---

*Built by Glayzz for Ranger Build-A-Bear Hackathon 2026*
*Vault: 88jtDH1zGT4DCJtQveLeUAEhoHgjtdRB8twUFSSMAKBm*