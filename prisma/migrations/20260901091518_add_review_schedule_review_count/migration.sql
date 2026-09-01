-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ReviewSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "errorItemId" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "completedAt" DATETIME,
    "isCorrect" BOOLEAN,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewSchedule_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ReviewSchedule" ("completedAt", "createdAt", "errorItemId", "id", "isCorrect", "scheduledFor") SELECT "completedAt", "createdAt", "errorItemId", "id", "isCorrect", "scheduledFor" FROM "ReviewSchedule";
DROP TABLE "ReviewSchedule";
ALTER TABLE "new_ReviewSchedule" RENAME TO "ReviewSchedule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
