"""
Backtest: Delta-Neutral SOL Funding Rate Arbitrage Vault
"""

import json, math
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

INITIAL_CAPITAL = 100_000
ENTRY_FEE_PCT   = 0.0010
PERP_FEE_PCT    = 0.0006
IDLE_BUFFER     = 0.05
MIN_FUND_APR    = 0.02
MGMT_FEE_ANN    = 0.015

SEED = 42
rng = np.random.default_rng(SEED)
N = 365 * 24 * 2

def gen_rates(n):
    rates = np.zeros(n)
    regime, regime_len = 1, 0
    for i in range(n):
        if regime_len == 0:
            regime = -1 if (regime == 1 and rng.random() < 0.25) else (1 if rng.random() < 0.70 else -1)
            regime_len = int(rng.integers(72, 24*21))
        rates[i] = rng.normal(0.00013, 0.00007) if regime == 1 else rng.normal(-0.00003, 0.00005)
        regime_len -= 1
    return rates

dates = pd.date_range("2023-01-01", periods=N, freq="h")
raw_rates = gen_rates(N)
smoothed = pd.Series(raw_rates).rolling(48, min_periods=1).mean().values

capital = INITIAL_CAPITAL
equity, fund_rates_ann, positions = [], [], []
in_pos, trades, fund_pnl = False, 0, 0.0

for i in range(N):
    ann = smoothed[i] * 24 * 365
    usable = capital * (1 - IDLE_BUFFER)

    if not in_pos:
        if ann > 0.10:
            capital -= usable * (ENTRY_FEE_PCT + 0.5 * PERP_FEE_PCT)
            in_pos, trades = True, trades + 1
    else:
        if ann < 0:
            capital -= usable * (ENTRY_FEE_PCT + 0.5 * PERP_FEE_PCT)
            in_pos, trades = False, trades + 1
        else:
            pay = capital * 0.5 * (1 - IDLE_BUFFER) * raw_rates[i]
            capital += pay
            fund_pnl += pay

    capital -= capital * (MGMT_FEE_ANN / 8760)
    equity.append(capital)
    fund_rates_ann.append(raw_rates[i] * 24 * 365)
    positions.append(1 if in_pos else 0)

equity = np.array(equity)
ret = (equity[-1] - INITIAL_CAPITAL) / INITIAL_CAPITAL
n_yrs = N / 8760
cagr = (equity[-1] / INITIAL_CAPITAL) ** (1/n_yrs) - 1
rets = np.diff(equity) / equity[:-1]
vol = rets.std() * math.sqrt(8760)
sharpe = (cagr - 0.05) / vol if vol > 0 else 0
peak = np.maximum.accumulate(equity)
mdd = np.max((peak - equity) / peak)

print(f"\n-- Backtest Results --")
print(f"  Total Return:  {ret:.1%}")
print(f"  CAGR:          {cagr:.1%}")
print(f"  Volatility:    {vol:.1%}")
print(f"  Sharpe:        {sharpe:.2f}")
print(f"  Max Drawdown:  {mdd:.1%}")
print(f"  Final Capital: ${equity[-1]:,.0f}")
print(f"  Funding PnL:   ${fund_pnl:,.0f}")
print(f"  Trades:        {trades}")

fig, axes = plt.subplots(3, 1, figsize=(14,10), facecolor="#0d0d0d")
fig.suptitle("Delta-Neutral SOL Funding Rate Vault - Backtest (2023-2025)",
             color="white", fontsize=14, fontweight="bold")

ax1, ax2, ax3 = axes
for ax in axes:
    ax.set_facecolor("#1a1a1a")
    ax.spines[["top","right","left","bottom"]].set_color("#444")
    ax.tick_params(colors="#aaa")
    ax.grid(color="#333", linewidth=0.5)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b '%y"))
    ax.xaxis.set_major_locator(mdates.MonthLocator(interval=3))
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=30, color="#aaa")

ax1.plot(dates, equity, color="#00e5ff", lw=1.5)
ax1.fill_between(dates, INITIAL_CAPITAL, equity, color="#00e5ff22")
ax1.axhline(INITIAL_CAPITAL, color="#555", lw=0.8, ls="--")
ax1.set_ylabel("Portfolio Value", color="#aaa")
ax1.set_title("Equity Curve", color="white")
ax1.yaxis.set_major_formatter(plt.FuncFormatter(lambda x,_: f"${x/1e3:.0f}K"))
summary = f"CAGR: {cagr:.1%}  |  Sharpe: {sharpe:.2f}  |  Max DD: {mdd:.1%}  |  Final: ${equity[-1]/1e3:.0f}K"
ax1.text(0.01, 0.95, summary, transform=ax1.transAxes, color="#00e5ff",
         fontsize=9, va="top", bbox=dict(boxstyle="round", fc="#111", alpha=0.8))

fr = np.array(fund_rates_ann)
pos_m = fr >= 0
ax2.fill_between(dates, 0, fr, where=pos_m, color="#00e676", alpha=0.6, label="Positive (collecting)")
ax2.fill_between(dates, 0, fr, where=~pos_m, color="#ff1744", alpha=0.6, label="Negative (exiting)")
ax2.axhline(0.10, color="yellow", lw=0.8, ls="--", label="Entry threshold (10% APR)")
ax2.set_ylabel("Funding Rate (APR)", color="#aaa")
ax2.set_title("SOL-PERP Hourly Funding Rate (Annualised)", color="white")
ax2.yaxis.set_major_formatter(plt.FuncFormatter(lambda x,_: f"{x:.0%}"))
ax2.legend(facecolor="#222", labelcolor="white", fontsize=8, loc="upper right")

ax3.fill_between(dates, 0, positions, color="#7c4dff", alpha=0.7, step="post")
ax3.set_ylabel("In Position", color="#aaa")
ax3.set_title("Position State (Purple = Short Perp Active)", color="white")
ax3.set_yticks([0,1])

plt.tight_layout()
plt.savefig("backtest_results.png", dpi=150, bbox_inches="tight", facecolor="#0d0d0d")
print("  Chart saved -> backtest_results.png")

with open("backtest_results.json","w") as f:
    json.dump({"cagr": f"{cagr:.1%}", "sharpe": f"{sharpe:.2f}",
               "max_drawdown": f"{mdd:.1%}", "total_return": f"{ret:.1%}",
               "final_capital": f"${equity[-1]:,.0f}", "funding_pnl": f"${fund_pnl:,.0f}",
               "trades": trades}, f, indent=2)
print("  Results saved -> backtest_results.json")