-- Post machine-translation cache (LibreTranslate, filled lazily on localized
-- pages) + the admin intake bot's state machine table.
-- Applied exactly once by `migrate deploy` (tracked in _prisma_migrations).

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "translations" JSONB;

-- CreateTable
CREATE TABLE "TelegramAdminState" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramAdminState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAdminState_adminUserId_key" ON "TelegramAdminState"("adminUserId");
