-- CreateTable
CREATE TABLE "PracticePaper" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subjectId" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "totalScore" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PracticePaper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PaperQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "section" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "isVariant" BOOLEAN NOT NULL,
    "sourceErrorItemId" TEXT,
    "questionText" TEXT NOT NULL,
    "answerText" TEXT NOT NULL,
    "analysis" TEXT NOT NULL,
    "knowledgePoints" TEXT,
    "originalImageUrl" TEXT,
    "isCorrect" BOOLEAN,
    CONSTRAINT "PaperQuestion_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "PracticePaper" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
