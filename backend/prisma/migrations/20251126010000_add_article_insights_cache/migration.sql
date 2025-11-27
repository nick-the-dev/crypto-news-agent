-- Add cached analysis insights to Article table
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "sentiment" TEXT;
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "keyPoints" TEXT[] DEFAULT '{}';
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "entities" TEXT[] DEFAULT '{}';
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "analyzedAt" TIMESTAMP(3);

-- Index for finding unanalyzed articles
CREATE INDEX IF NOT EXISTS "Article_analyzedAt_idx" ON "Article"("analyzedAt");
