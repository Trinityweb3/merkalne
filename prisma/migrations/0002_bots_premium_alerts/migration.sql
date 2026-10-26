-- Bots & premium job alerts
--   * User gains plan/premiumUntil (premium subscribers)
--   * Post gains source/sourceRef/notifiedAt (ingestion dedupe + dispatch state)
--   * New tables: TelegramLink, DiscordWebhook, NotificationLog, IngestionLog

-- AlterTable: premium subscriber state
ALTER TABLE "User" ADD COLUMN "plan"         TEXT NOT NULL DEFAULT 'free',
                   ADD COLUMN "premiumUntil" TIMESTAMP(3);

-- AlterTable: ingestion + dispatch bookkeeping on every posting
ALTER TABLE "Post" ADD COLUMN "source"     TEXT NOT NULL DEFAULT 'web',
                   ADD COLUMN "sourceRef"  TEXT,
                   ADD COLUMN "notifiedAt" TIMESTAMP(3);

-- CreateIndex (User)
CREATE INDEX "User_plan_idx" ON "User"("plan");

-- CreateIndex (Post)
CREATE INDEX "Post_status_notifiedAt_idx" ON "Post"("status", "notifiedAt");
CREATE INDEX "Post_source_sourceRef_idx" ON "Post"("source", "sourceRef");

-- CreateTable: Telegram account link for premium job alerts
CREATE TABLE "TelegramLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT,
    "username" TEXT,
    "linkTokenHash" TEXT NOT NULL,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable: personal Discord webhook for premium job alerts
CREATE TABLE "DiscordWebhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "urlEnc" TEXT NOT NULL,
    "label" TEXT,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscordWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable: per-post × per-channel delivery ledger
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: audit trail for bot/worker writes
CREATE TABLE "IngestionLog" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (TelegramLink)
CREATE UNIQUE INDEX "TelegramLink_userId_key" ON "TelegramLink"("userId");
CREATE UNIQUE INDEX "TelegramLink_chatId_key" ON "TelegramLink"("chatId");
CREATE UNIQUE INDEX "TelegramLink_linkTokenHash_key" ON "TelegramLink"("linkTokenHash");
CREATE INDEX "TelegramLink_userId_idx" ON "TelegramLink"("userId");

-- CreateIndex (DiscordWebhook)
CREATE UNIQUE INDEX "DiscordWebhook_userId_key" ON "DiscordWebhook"("userId");
CREATE INDEX "DiscordWebhook_userId_idx" ON "DiscordWebhook"("userId");

-- CreateIndex (NotificationLog)
CREATE UNIQUE INDEX "NotificationLog_postId_channel_recipient_key" ON "NotificationLog"("postId", "channel", "recipient");
CREATE INDEX "NotificationLog_status_createdAt_idx" ON "NotificationLog"("status", "createdAt");
CREATE INDEX "NotificationLog_postId_idx" ON "NotificationLog"("postId");
CREATE INDEX "NotificationLog_userId_idx" ON "NotificationLog"("userId");

-- CreateIndex (IngestionLog)
CREATE INDEX "IngestionLog_source_createdAt_idx" ON "IngestionLog"("source", "createdAt");
CREATE INDEX "IngestionLog_ok_createdAt_idx" ON "IngestionLog"("ok", "createdAt");

-- AddForeignKey
ALTER TABLE "TelegramLink" ADD CONSTRAINT "TelegramLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiscordWebhook" ADD CONSTRAINT "DiscordWebhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;
