-- CreateTable
CREATE TABLE "RefreshRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "budget" INTEGER NOT NULL DEFAULT 0,
    "due" INTEGER NOT NULL DEFAULT 0,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FeedSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feedId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "resolvedUrl" TEXT,
    "config" TEXT,
    "lastFetched" DATETIME,
    "nextRefreshAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FeedSource_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_FeedSource" ("config", "createdAt", "feedId", "id", "lastFetched", "resolvedUrl", "type", "updatedAt", "url") SELECT "config", "createdAt", "feedId", "id", "lastFetched", "resolvedUrl", "type", "updatedAt", "url" FROM "FeedSource";
DROP TABLE "FeedSource";
ALTER TABLE "new_FeedSource" RENAME TO "FeedSource";
CREATE INDEX "FeedSource_nextRefreshAt_idx" ON "FeedSource"("nextRefreshAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
