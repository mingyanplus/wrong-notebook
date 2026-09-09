-- AlterTable
ALTER TABLE "ErrorItem" ADD COLUMN "imageMasks" TEXT;
ALTER TABLE "ErrorItem" ADD COLUMN "requiresImage" BOOLEAN;

-- AlterTable
ALTER TABLE "PaperQuestion" ADD COLUMN "requiresImage" BOOLEAN;
