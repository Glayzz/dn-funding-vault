/**
 * Vault Setup Script
 * Run once to create and configure the funding rate arb vault on Ranger Earn
 *
 * Usage:
 *   npx ts-node src/setup-vault.ts
 *
 * Note: This vault uses EOA-based execution against Flash Trade directly.
 * No adaptor is registered — Flash Trade perp calls are made by the manager EOA.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import BN from "bn.js";
import * as fs from "fs";

// USDC mint (mainnet + devnet)
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")))
  );
}

async function setupVault(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("./admin.json");
  const manager = loadKeypair("./manager.json");
  const vault = Keypair.generate();

  console.log("Setting up Delta-Neutral Funding Rate Vault...");
  console.log(`  Network:       ${RPC_URL.includes("devnet") ? "DEVNET" : "MAINNET"}`);
  console.log(`  Vault address: ${vault.publicKey.toBase58()}`);
  console.log(`  Admin:         ${admin.publicKey.toBase58()}`);
  console.log(`  Manager:       ${manager.publicKey.toBase58()}`);

  const client = new VoltrClient(connection, admin);

  // Step 1: Initialize vault
  console.log("\n[1/3] Initializing vault...");
  try {
    const initVaultIx = await client.createInitializeVaultIx(
      {
        config: {
          maxCap: new BN(10_000_000_000_000),
          startAtTs: new BN(Math.floor(Date.now() / 1000)),
          lockedProfitDegradationDuration: new BN(21600),
          managerManagementFee: 150,
          managerPerformanceFee: 1000,
          adminManagementFee: 0,
          adminPerformanceFee: 0,
          redemptionFee: 0,
          issuanceFee: 0,
          withdrawalWaitingPeriod: new BN(0),
        },
        name: "DN Funding Rate Vault",
        description: "Delta-neutral SOL funding rate arbitrage via Flash Trade + Jupiter",
      },
      {
        vault: vault.publicKey,
        vaultAssetMint: USDC_MINT,
        admin: admin.publicKey,
        manager: manager.publicKey,
        payer: admin.publicKey,
      }
    );

    const tx1 = new Transaction().add(initVaultIx);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [admin, vault]);
    const cluster = RPC_URL.includes("devnet") ? "?cluster=devnet" : "";
    console.log(`  Vault initialized: ${sig1}`);
    console.log(`  Explorer: https://explorer.solana.com/tx/${sig1}${cluster}`);
  } catch (err: any) {
    console.error("  Error initializing vault:", err.message);
    console.log("  Tip: Make sure admin.json has SOL. Run: solana airdrop 2 --keypair admin.json --url devnet");
    process.exit(1);
  }

  // Step 2: Create LP token metadata
  console.log("\n[2/3] Creating LP token metadata...");
  try {
    const metadataIx = await client.createCreateLpMetadataIx(
      {
        name: "DN Funding LP",
        symbol: "DNFLP",
        uri: "https://raw.githubusercontent.com/Glayzz/dn-funding-vault/main/metadata.json",
      },
      {
        payer: admin.publicKey,
        admin: admin.publicKey,
        vault: vault.publicKey,
      }
    );
    const tx2 = new Transaction().add(metadataIx);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [admin]);
    console.log(`  LP metadata created: ${sig2}`);
  } catch (err: any) {
    console.log("  LP metadata skipped (non-critical):", err.message);
  }

  // Step 3: Save config
  console.log("\n[3/3] Saving configuration...");
  const config = {
    vaultAddress: vault.publicKey.toBase58(),
    adminPubkey: admin.publicKey.toBase58(),
    managerPubkey: manager.publicKey.toBase58(),
    assetMint: USDC_MINT.toBase58(),
    network: RPC_URL.includes("devnet") ? "devnet" : "mainnet",
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync("./vault-config.json", JSON.stringify(config, null, 2));
  console.log("  Config saved to vault-config.json");

  const cluster = RPC_URL.includes("devnet") ? "?cluster=devnet" : "";
  console.log("\n✓ Vault setup complete!");
  console.log(`  https://explorer.solana.com/address/${vault.publicKey.toBase58()}${cluster}`);
}

setupVault().catch(console.error);