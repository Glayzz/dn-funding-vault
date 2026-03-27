/**
 * Vault Setup Script
 * Run once to create and configure the funding rate arb vault on Ranger Earn
 *
 * Usage:
 *   npx ts-node src/setup-vault.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  VoltrClient,
  DRIFT_ADAPTOR_PROGRAM_ID,
  VaultConfigField,
} from "@voltr/vault-sdk";
import BN from "bn.js";
import * as fs from "fs";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8")))
  );
}

async function setupVault(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("./admin.json");
  const manager = loadKeypair("./manager.json");
  const payer = admin; // payer = admin for setup
  const vault = Keypair.generate(); // new vault keypair

  console.log("Setting up Delta-Neutral Funding Rate Vault…");
  console.log(`  Vault address: ${vault.publicKey.toBase58()}`);
  console.log(`  Admin:         ${admin.publicKey.toBase58()}`);
  console.log(`  Manager:       ${manager.publicKey.toBase58()}`);

  const client = new VoltrClient(connection, admin);

  // ── Step 1: Initialize vault ─────────────────────────────────────────────
  console.log("\n[1/4] Initializing vault…");
  const initVaultIx = await client.createInitializeVaultIx(
    {
      config: {
        maxCap: new BN(10_000_000_000_000), // $10M max cap
        startAtTs: new BN(Math.floor(Date.now() / 1000)),
        lockedProfitDegradationDuration: new BN(21600), // 6 hours profit lock
        managerManagementFee: 150,    // 1.5% management fee (basis points)
        managerPerformanceFee: 1000,  // 10% performance fee
        adminManagementFee: 0,
        adminPerformanceFee: 0,
        redemptionFee: 0,
        issuanceFee: 0,
        withdrawalWaitingPeriod: new BN(86400), // 24-hour withdrawal delay
      },
      name: "DN Funding Rate Vault",
      description: "Delta-neutral SOL funding rate arbitrage",
    },
    {
      vault: vault.publicKey,
      vaultAssetMint: USDC_MINT,
      admin: admin.publicKey,
      manager: manager.publicKey,
      payer: payer.publicKey,
    }
  );

  const tx1 = new Transaction().add(initVaultIx);
  const sig1 = await sendAndConfirmTransaction(connection, tx1, [admin, vault]);
  console.log(`  ✓ Vault initialized: ${sig1}`);

  // ── Step 2: Create LP token metadata ─────────────────────────────────────
  console.log("\n[2/4] Creating LP token metadata…");
  const metadataIx = await client.createCreateLpMetadataIx(
    {
      name: "DN Funding LP",
      symbol: "DNFLP",
      uri: "https://raw.githubusercontent.com/your-org/vault-metadata/main/dn-funding.json",
    },
    {
      payer: payer.publicKey,
      admin: admin.publicKey,
      vault: vault.publicKey,
    }
  );
  const tx2 = new Transaction().add(metadataIx);
  const sig2 = await sendAndConfirmTransaction(connection, tx2, [admin]);
  console.log(`  ✓ LP metadata created: ${sig2}`);

  // ── Step 3: Add Drift adaptor ─────────────────────────────────────────────
  console.log("\n[3/4] Adding Drift adaptor…");
  const addAdaptorIx = await client.createAddAdaptorIx({
    vault: vault.publicKey,
    payer: payer.publicKey,
    admin: admin.publicKey,
    adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
  });
  const tx3 = new Transaction().add(addAdaptorIx);
  const sig3 = await sendAndConfirmTransaction(connection, tx3, [admin]);
  console.log(`  ✓ Drift adaptor added: ${sig3}`);

  // ── Step 4: Save vault address ────────────────────────────────────────────
  console.log("\n[4/4] Saving configuration…");
  const config = {
    vaultAddress: vault.publicKey.toBase58(),
    adminPubkey: admin.publicKey.toBase58(),
    managerPubkey: manager.publicKey.toBase58(),
    assetMint: USDC_MINT.toBase58(),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync("./vault-config.json", JSON.stringify(config, null, 2));
  console.log("  ✓ Config saved to vault-config.json");

  console.log("\n🎉 Vault setup complete!");
  console.log(`   Add VAULT_ADDRESS=${vault.publicKey.toBase58()} to your .env`);
}

setupVault().catch(console.error);
