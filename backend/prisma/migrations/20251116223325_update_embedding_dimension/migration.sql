/*
  Warnings:

  - Made the column `embedding` on table `ArticleEmbedding` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "article_embedding_idx";

-- AlterTable
ALTER TABLE "ArticleEmbedding" ALTER COLUMN "embedding" SET NOT NULL;
