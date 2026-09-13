-- AlterTable
ALTER TABLE "User" ADD COLUMN "variantSettings" TEXT;

-- CreateTable
CREATE TABLE "VariantQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "errorItemId" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "questionText" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "analysis" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VariantQuestion_errorItemId_fkey" FOREIGN KEY ("errorItemId") REFERENCES "ErrorItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "VariantQuestion_errorItemId_difficulty_idx" ON "VariantQuestion"("errorItemId", "difficulty");
