/**
 * Donation wallet configuration (server-side).
 *
 * Addresses come strictly from the environment — nothing is invented, and
 * the UI never shows a wallet that is not configured. Labels are part of
 * this module (not the env) so a future translation layer owns them.
 */
import { env } from '@/lib/env'

export interface DonationWallet {
  /** Stable id for UI keys. */
  id: 'sol' | 'btc' | 'usdt-evm'
  /** Human network label — tells the donor WHICH network to use. */
  network: string
  /** What the donor sends on that network. */
  currency: string
  address: string
}

/**
 * USDT on EVM: one address covers every EVM chain the owner uses
 * (Ethereum, BNB Chain, Arbitrum One…) — the same 0x address is valid on
 * all of them, which is why the label lists the chains explicitly.
 */
export function getDonationWallets(): DonationWallet[] {
  const wallets: DonationWallet[] = []

  if (env.DONATION_SOL_ADDRESS) {
    wallets.push({
      id: 'sol',
      network: 'Solana',
      currency: 'SOL',
      address: env.DONATION_SOL_ADDRESS,
    })
  }
  if (env.DONATION_BTC_ADDRESS) {
    wallets.push({
      id: 'btc',
      network: 'Bitcoin',
      currency: 'BTC',
      address: env.DONATION_BTC_ADDRESS,
    })
  }
  if (env.DONATION_USDT_EVM_ADDRESS) {
    wallets.push({
      id: 'usdt-evm',
      network: 'EVM — Ethereum / BNB Chain / Arbitrum One',
      currency: 'USDT',
      address: env.DONATION_USDT_EVM_ADDRESS,
    })
  }

  return wallets
}
