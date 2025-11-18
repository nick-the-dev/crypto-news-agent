-- Delete all existing embeddings (incompatible with new dimension)
TRUNCATE TABLE "ArticleEmbedding" CASCADE;

-- Drop and recreate the embedding column with new dimensions
ALTER TABLE "ArticleEmbedding" DROP COLUMN embedding;
ALTER TABLE "ArticleEmbedding" ADD COLUMN embedding vector(4096) NOT NULL;
