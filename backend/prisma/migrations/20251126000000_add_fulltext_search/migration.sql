-- Add full-text search support using PostgreSQL tsvector

-- Article: Add tsvector column with weighted content
ALTER TABLE "Article" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

UPDATE "Article" SET "searchVector" =
  setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
  setweight(to_tsvector('english', COALESCE(summary, '')), 'B') ||
  setweight(to_tsvector('english', COALESCE(content, '')), 'C');

CREATE INDEX IF NOT EXISTS "Article_searchVector_idx" ON "Article" USING GIN ("searchVector");

-- ArticleChunk: Add tsvector column
ALTER TABLE "ArticleChunk" ADD COLUMN IF NOT EXISTS "searchVector" tsvector;

UPDATE "ArticleChunk" SET "searchVector" = to_tsvector('english', COALESCE(content, ''));

CREATE INDEX IF NOT EXISTS "ArticleChunk_searchVector_idx" ON "ArticleChunk" USING GIN ("searchVector");

-- Auto-update trigger for Article
CREATE OR REPLACE FUNCTION update_article_search_vector() RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS article_search_vector_update ON "Article";
CREATE TRIGGER article_search_vector_update
  BEFORE INSERT OR UPDATE ON "Article"
  FOR EACH ROW EXECUTE FUNCTION update_article_search_vector();

-- Auto-update trigger for ArticleChunk
CREATE OR REPLACE FUNCTION update_chunk_search_vector() RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_search_vector_update ON "ArticleChunk";
CREATE TRIGGER chunk_search_vector_update
  BEFORE INSERT OR UPDATE ON "ArticleChunk"
  FOR EACH ROW EXECUTE FUNCTION update_chunk_search_vector();
