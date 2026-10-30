-- Team CMS: fully dynamic /about team section, managed via the Telegram
-- admin bot (👥 Manage team → ➕ Add New Member / per-member edits / 🗑 Remove).
--
-- TeamMember replaces the hardcoded team list (src/lib/about-content.ts) AND
-- the legacy team_<member>_bio / team_<member>_avatar SiteSetting overrides:
-- on first read after this migration the lazy seed in src/lib/team.ts copies
-- those legacy values into the three default rows, then every subsequent
-- read/write goes straight to this table. `order` is the sort key (ascending);
-- the bot appends new members with order = max(order) + 1.

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "bio" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "socialUrl" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);
