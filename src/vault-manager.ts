/**
 * Delta-Neutral SOL Funding Rate Arbitrage Vault — Manager Bot
 * Ranger Build-A-Bear Hackathon — Main Track
 *
 * Architecture: EOA-based execution (no adaptor required)
 * - Vault holds USDC via Voltr / Ranger Earn
 * - Manager EOA calls Flash Trade perp program directly (no Voltr adaptor wrapper)
 * - Jupiter swap called directly for spot SOL leg
 *
 * Per Ranger admin (Shayn, 2026-04-08):
 *   "No flash adaptor right now. But our hackathon is not limited to
 *    only adaptors/protocols we are integrated. You can create strategies
 *    with EOAs on any protocols."
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { VoltrClient } from "@voltr/vault-sdk";
import { BN } from "bn.js";
import * as fs from "fs";

// ─── Config ────────────────────────────────────────────────────────────────

const config = JSON.parse(fs.readFileSync("./vault-config.json", "utf-8"));

const RPC_URL     = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const MANAGER_KEY = JSON.parse(process.env.MANAGER_KEYPAIR ?? "[]");

const VAULT = new PublicKey(config.vaultAddress);
const ADMIN = new PublicKey(config.adminPubkey);

// ── Token mints ─────────────────────────────────────────────────────────────
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_MINT  = new PublicKey("So11111111111111111111111111111111111111112");

// ── Flash Trade program + accounts (Mainnet) ─────────────────────────────────
// https://docs.flash.trade/developers/contract-addresses
const FLASH_PROGRAM_ID    = new PublicKey("FLEXoAaFuXBZFBGpEMQA28a95VBGWVfwmZRCiKaZbFaU");
const FLASH_POOL          = new PublicKey("5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsQ");
const FLASH_SOL_CUSTODY   = new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz");
const FLASH_USDC_CUSTODY  = new PublicKey("G18jKKXLifBCLkne7aBv4veGBB5DKRY83pN6xDGCeJkR");

// ── Jupiter API ──────────────────────────────────────────────────────────────
const JUP_QUOTE_API = "https://quote-api.jup.ag/v6/quote";
const JUP_SWAP_API  = "https://quote-api.jup.ag/v6/swap";

// ── Strategy constants ───────────────────────────────────────────────────────
const DELTA_REBALANCE_THRESHOLD = 0.02;
const MIN_FUNDING_APR           = 0.02;
const ENTRY_FUNDING_APR         = 0.10;
const IDLE_BUFFER_PCT           = 0.05;
const PERP_COLLATERAL_PCT       = 0.475;
const SPOT_PCT                  = 0.475;
const MAX_LEVERAGE              = 2;
const CHECK_INTERVAL_MS         = 60_000;
const SOFT_DRAWDOWN_LIMIT       = 0.05;
const HARD_DRAWDOWN_LIMIT       = 0.10;

// ─── Persisted state ─────────────────────────────────────────────────────────

interface BotState {
  inPosition:      boolean;
  highWaterMark:   number;
  perpPositionKey: string | null;
  spotSolAmount:   number;
}

const STATE_FILE = "./bot-state.json";

function loadState(): BotState {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  return { inPosition: false, highWaterMark: 0, perpPositionKey: null, spotSolAmount: 0 };
}

function saveState(s: BotState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log   = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ─── Flash Trade: funding rate reader ────────────────────────────────────────
// Reads the SOL custody account to get hourly funding rate.
// Flash stores hourlyFundingRateBps (i64, * 1e6) at byte offset 241.
// Positive value = longs pay shorts = we collect funding on the short.

async function getFlashFundingRateApr(connection: Connection): Promise<number> {
  try {
    const info = await connection.getAccountInfo(FLASH_SOL_CUSTODY);
    if (!info) throw new Error("Flash SOL custody account not found");
    const raw = info.data.readBigInt64LE(296);
    const hourlyDecimal = Number(raw) / 1_000_000;
    return hourlyDecimal * 24 * 365;
  } catch (err) {
    log(`WARN: funding rate read failed — ${err}`);
    return 0;
  }
}

// ─── Vault NAV ───────────────────────────────────────────────────────────────

async function getVaultNav(client: VoltrClient): Promise<number> {
  const { totalValue } = await client.getPositionAndTotalValuesForVault(VAULT);
  return Number(totalValue);
}

// ─── Jupiter: spot swaps ─────────────────────────────────────────────────────

async function swapUsdcToSol(
  connection: Connection,
  manager: Keypair,
  usdcMicros: number
): Promise<number> {
  log(`Jupiter: swapping ${usdcMicros / 1e6} USDC → SOL`);
  const quote = await (await fetch(
    `${JUP_QUOTE_API}?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${usdcMicros}&slippageBps=50`
  )).json();

  const { swapTransaction } = await (await fetch(JUP_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: manager.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  })).json();

  const tx = Transaction.from(Buffer.from(swapTransaction, "base64"));
  tx.partialSign(manager);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  log(`✓ SOL purchased (${Number(quote.outAmount) / 1e9} SOL), tx: ${sig}`);
  return Number(quote.outAmount);
}

async function swapSolToUsdc(
  connection: Connection,
  manager: Keypair,
  solLamports: number
): Promise<void> {
  log(`Jupiter: swapping ${solLamports / 1e9} SOL → USDC`);
  const quote = await (await fetch(
    `${JUP_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${solLamports}&slippageBps=50`
  )).json();

  const { swapTransaction } = await (await fetch(JUP_SWAP_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: manager.publicKey.toBase58(), wrapAndUnwrapSol: true }),
  })).json();

  const tx = Transaction.from(Buffer.from(swapTransaction, "base64"));
  tx.partialSign(manager);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  log(`✓ SOL sold, tx: ${sig}`);
}

// ─── Flash Trade: open/close short ──────────────────────────────────────────
// Direct on-chain calls using Flash Trade program instruction layout.
// Discriminators from Flash Trade IDL — verify against current IDL before deploy.

function buildOpenShortIx(
  manager: PublicKey,
  positionAccount: PublicKey,
  collateralUsdcMicros: BN,
  sizeUsdcMicros: BN
): TransactionInstruction {
  // "openPosition" discriminator (Flash Trade IDL)
  const disc = Buffer.from([0x6f, 0x70, 0x65, 0x6e, 0x50, 0x6f, 0x73, 0x00]);
  const data = Buffer.alloc(disc.length + 8 + 8 + 1);
  disc.copy(data, 0);
  collateralUsdcMicros.toArrayLike(Buffer, "le", 8).copy(data, disc.length);
  sizeUsdcMicros.toArrayLike(Buffer, "le", 8).copy(data, disc.length + 8);
  data.writeUInt8(1, disc.length + 16); // side: 1 = Short

  return new TransactionInstruction({
    programId: FLASH_PROGRAM_ID,
    keys: [
      { pubkey: manager,           isSigner: true,  isWritable: true  },
      { pubkey: positionAccount,   isSigner: false, isWritable: true  },
      { pubkey: FLASH_POOL,        isSigner: false, isWritable: true  },
      { pubkey: FLASH_SOL_CUSTODY, isSigner: false, isWritable: true  },
      { pubkey: FLASH_USDC_CUSTODY,isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildCloseShortIx(
  manager: PublicKey,
  positionAccount: PublicKey
): TransactionInstruction {
  const disc = Buffer.from([0x63, 0x6c, 0x6f, 0x73, 0x65, 0x50, 0x6f, 0x73]);

  return new TransactionInstruction({
    programId: FLASH_PROGRAM_ID,
    keys: [
      { pubkey: manager,           isSigner: true,  isWritable: true  },
      { pubkey: positionAccount,   isSigner: false, isWritable: true  },
      { pubkey: FLASH_POOL,        isSigner: false, isWritable: true  },
      { pubkey: FLASH_SOL_CUSTODY, isSigner: false, isWritable: true  },
      { pubkey: FLASH_USDC_CUSTODY,isSigner: false, isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

// ─── High-level position management ─────────────────────────────────────────

async function openPosition(
  connection: Connection,
  manager: Keypair,
  nav: number,
  state: BotState
): Promise<BotState> {
  const usable   = nav * (1 - IDLE_BUFFER_PCT);
  const perpUsdc = Math.floor(usable * PERP_COLLATERAL_PCT * 1e6);
  const spotUsdc = Math.floor(usable * SPOT_PCT * 1e6);

  log(`Opening position | Perp: $${perpUsdc / 1e6} | Spot: $${spotUsdc / 1e6}`);

  // Spot leg: buy SOL
  const solReceived = await swapUsdcToSol(connection, manager, spotUsdc);

  // Perp leg: open Flash Trade short
  const positionKeypair = Keypair.generate();
  const size = new BN(perpUsdc * MAX_LEVERAGE);
  const ix = buildOpenShortIx(
    manager.publicKey,
    positionKeypair.publicKey,
    new BN(perpUsdc),
    size
  );
  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(connection, tx, [manager, positionKeypair]);

  log(`✓ Flash short open | Position: ${positionKeypair.publicKey.toBase58()}`);

  return { ...state, inPosition: true, perpPositionKey: positionKeypair.publicKey.toBase58(), spotSolAmount: solReceived };
}

async function closePosition(
  connection: Connection,
  manager: Keypair,
  state: BotState
): Promise<BotState> {
  log("Closing position");

  if (state.perpPositionKey) {
    const ix = buildCloseShortIx(manager.publicKey, new PublicKey(state.perpPositionKey));
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [manager]);
    log("✓ Flash short closed");
  }

  if (state.spotSolAmount > 0) {
    await swapSolToUsdc(connection, manager, state.spotSolAmount);
  }

  return { ...state, inPosition: false, perpPositionKey: null, spotSolAmount: 0 };
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  if (MANAGER_KEY.length === 0) throw new Error("Set MANAGER_KEYPAIR env var");

  const connection = new Connection(RPC_URL, "confirmed");
  const manager    = Keypair.fromSecretKey(Uint8Array.from(MANAGER_KEY));
  const client     = new VoltrClient(connection);

  log("=== DN Funding Vault — EOA/Flash Trade mode ===");
  log(`Vault  : ${VAULT.toBase58()}`);
  log(`Manager: ${manager.publicKey.toBase58()}`);

  let state = loadState();
  if (state.highWaterMark === 0) {
    state.highWaterMark = await getVaultNav(client);
    saveState(state);
  }

  while (true) {
    try {
      const fundingApr = await getFlashFundingRateApr(connection);
      const nav        = await getVaultNav(client);
      const drawdown   = (state.highWaterMark - nav) / state.highWaterMark;

      log(`Funding APR: ${(fundingApr * 100).toFixed(2)}% | NAV: $${nav.toFixed(2)} | DD: ${(drawdown * 100).toFixed(2)}% | Pos: ${state.inPosition}`);

      if (nav > state.highWaterMark) { state.highWaterMark = nav; saveState(state); }

      if (drawdown >= HARD_DRAWDOWN_LIMIT) {
        log("⚠️  HARD DRAWDOWN — closing everything");
        if (state.inPosition) { state = await closePosition(connection, manager, state); saveState(state); }
        await sleep(CHECK_INTERVAL_MS * 5);
        continue;
      }

      if (!state.inPosition && fundingApr > ENTRY_FUNDING_APR) {
        state = await openPosition(connection, manager, nav, state);
        saveState(state);
      } else if (state.inPosition && fundingApr < MIN_FUNDING_APR) {
        log("Funding below threshold — exiting");
        state = await closePosition(connection, manager, state);
        saveState(state);
      }

      // Fee harvest
      const fees = await client.getAccumulatedManagerFeesForVault(VAULT);
      if (Number(fees) > 1_000_000) {
        const ix = await client.createHarvestFeeIx({ harvester: manager.publicKey, vaultManager: manager.publicKey, vaultAdmin: ADMIN, protocolAdmin: ADMIN, vault: VAULT });
        await sendAndConfirmTransaction(connection, new Transaction().add(ix), [manager]);
        log(`Harvested ${Number(fees) / 1e6} USDC in fees`);
      }

    } catch (err) {
      log(`ERROR: ${err}`);
    }

    await sleep(CHECK_INTERVAL_MS);
  }
}

main().catch(console.error);
