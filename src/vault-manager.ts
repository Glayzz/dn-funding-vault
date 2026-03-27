/**
 * Delta-Neutral Funding Rate Arbitrage Vault
 * Built on Ranger Earn + Drift Protocol
 *
 * Strategy:
 *   - Accepts USDC deposits
 *   - Holds spot SOL (via Jupiter swap)
 *   - Simultaneously opens a short SOL-PERP on Drift
 *   - Net delta = 0 (market-neutral)
 *   - Profit source = funding rate payments received on the short position
 *   - Rebalances when delta drifts beyond ±2% or funding rate turns negative
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { VoltrClient, DRIFT_ADAPTOR_PROGRAM_ID } from "@voltr/vault-sdk";
import BN from "bn.js";
import * as fs from "fs";

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  RPC_URL: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  VAULT_ADDRESS: process.env.VAULT_ADDRESS ?? "",
  MANAGER_KEYPAIR_PATH: process.env.MANAGER_KEYPAIR_PATH ?? "./manager.json",
  ADMIN_KEYPAIR_PATH: process.env.ADMIN_KEYPAIR_PATH ?? "./admin.json",

  // Risk parameters
  MAX_DELTA_DRIFT_PCT: 0.02,      // rebalance if net delta exceeds ±2%
  MIN_FUNDING_RATE_APR: 0.02,     // exit short if annual funding drops below 2%
  MAX_LEVERAGE: 2.0,               // never exceed 2x on perp short
  IDLE_BUFFER_PCT: 0.05,           // keep 5% USDC idle for gas & redemptions

  // Polling
  POLL_INTERVAL_MS: 60_000,        // check every 60 seconds
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Fetch current 1-hour funding rate for SOL-PERP from Drift's public API */
async function fetchSolFundingRateApr(): Promise<number> {
  const res = await fetch(
    "https://mainnet-beta.api.drift.trade/fundingRates?marketIndex=0&limit=1"
  );
  const json = await res.json();
  const hourlyRate: number = json?.fundingRates?.[0]?.fundingRate ?? 0;
  // Annualise: 24 epochs/day × 365 days
  return hourlyRate * 24 * 365;
}

/** Fetch current SOL spot price from Jupiter price API */
async function fetchSolPrice(): Promise<number> {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const res = await fetch(`https://price.jup.ag/v6/price?ids=${SOL_MINT}`);
  const json = await res.json();
  return json?.data?.[SOL_MINT]?.price ?? 0;
}

// ── Core Strategy Logic ───────────────────────────────────────────────────────

async function runRebalanceCycle(
  client: VoltrClient,
  vault: PublicKey,
  manager: Keypair
): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] Running rebalance cycle…`);

  // 1. Fetch vault state
  const { totalValue, strategies } = await client.getPositionAndTotalValuesForVault(vault);
  console.log(`  Total vault value: $${(totalValue / 1e6).toFixed(2)} USDC`);

  // 2. Check funding rate — exit/reduce if unfavorable
  const fundingApr = await fetchSolFundingRateApr();
  console.log(`  SOL-PERP funding APR: ${(fundingApr * 100).toFixed(2)}%`);

  if (fundingApr < CONFIG.MIN_FUNDING_RATE_APR) {
    console.log("  ⚠️  Funding rate below threshold — closing perp short.");
    await closePerpShort(client, vault, manager, strategies);
    return;
  }

  // 3. Compute desired allocation
  const usableCapital = totalValue * (1 - CONFIG.IDLE_BUFFER_PCT);
  const targetShortNotional = usableCapital * 0.5; // 50% of usable in perp short

  // 4. Check current delta vs target — rebalance if needed
  const currentShortNotional = await getCurrentShortNotional(strategies);
  const deltaDrift =
    Math.abs(currentShortNotional - targetShortNotional) / (targetShortNotional || 1);

  console.log(
    `  Short notional — current: $${(currentShortNotional / 1e6).toFixed(2)}, ` +
    `target: $${(targetShortNotional / 1e6).toFixed(2)}, drift: ${(deltaDrift * 100).toFixed(2)}%`
  );

  if (deltaDrift > CONFIG.MAX_DELTA_DRIFT_PCT) {
    console.log("  ↻  Delta drift exceeded — rebalancing…");
    await rebalancePositions(client, vault, manager, targetShortNotional, strategies);
  } else {
    console.log("  ✓  Portfolio within tolerance. No action needed.");
  }
}

/**
 * Placeholder — in production this reads on-chain position size from
 * the Drift strategy account via the Ranger SDK remainingAccounts pattern.
 */
async function getCurrentShortNotional(_strategies: unknown): Promise<number> {
  // TODO: parse strategy account data from Drift adaptor to get real position
  return 0;
}

async function closePerpShort(
  client: VoltrClient,
  vault: PublicKey,
  manager: Keypair,
  _strategies: unknown
): Promise<void> {
  console.log("  Closing Drift perp short via withdraw strategy ix…");
  // Withdraw full amount from Drift perp strategy back to vault idle
  // (actual implementation uses drift-scripts pattern from voltrxyz/drift-scripts)
  console.log("  [stub] createWithdrawStrategyIx → Drift adaptor");
}

async function rebalancePositions(
  client: VoltrClient,
  vault: PublicKey,
  manager: Keypair,
  targetShortNotional: number,
  _strategies: unknown
): Promise<void> {
  console.log(`  Allocating $${(targetShortNotional / 1e6).toFixed(2)} USDC to Drift perp short…`);
  // Uses createDepositStrategyIx with DRIFT_ADAPTOR_PROGRAM_ID
  // remainingAccounts = Drift market accounts (see drift-scripts repo)
  console.log("  [stub] createDepositStrategyIx → DRIFT_ADAPTOR_PROGRAM_ID");
  console.log("  [stub] Jupiter swap: USDC → SOL for spot leg");
}

// ── Entry Point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const connection = new Connection(CONFIG.RPC_URL, "confirmed");
  const manager = loadKeypair(CONFIG.MANAGER_KEYPAIR_PATH);
  const client = new VoltrClient(connection, manager);
  const vault = new PublicKey(CONFIG.VAULT_ADDRESS);

  console.log("🐻 Delta-Neutral Funding Rate Vault — Manager Bot");
  console.log(`   Vault:   ${vault.toBase58()}`);
  console.log(`   Manager: ${manager.publicKey.toBase58()}`);
  console.log(`   Polling every ${CONFIG.POLL_INTERVAL_MS / 1000}s\n`);

  // Initial cycle then poll
  await runRebalanceCycle(client, vault, manager);
  setInterval(() => runRebalanceCycle(client, vault, manager), CONFIG.POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
