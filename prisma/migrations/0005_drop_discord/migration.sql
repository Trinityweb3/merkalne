-- Discord is dropped as an ingestion + alerts channel (product decision).
-- Premium alerts are now email (Resend) + Telegram DMs only; the personal
-- Discord webhook table (AES-256-GCM encrypted URLs) is no longer read by any
-- code path. Legacy NotificationLog rows with channel='discord' are aged out
-- by the retry cap (marked failed with error='channel_removed'), NOT deleted
-- here — the ledger keeps its audit trail.

-- DropTable
DROP TABLE IF EXISTS "DiscordWebhook";
