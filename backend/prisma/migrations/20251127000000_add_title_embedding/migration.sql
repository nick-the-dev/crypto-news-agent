-- Add titleEmbedding column for caching article title embeddings
-- This eliminates ~100 embedding API calls per analysis query
-- No index needed: cosine similarity is computed in-memory for source ranking

ALTER TABLE "Article" ADD COLUMN "titleEmbedding" vector(4096);
