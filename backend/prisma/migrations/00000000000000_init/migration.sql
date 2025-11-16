-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "summary" TEXT,
    "source" TEXT NOT NULL,
    "author" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleChunk" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "isIntro" BOOLEAN NOT NULL DEFAULT false,
    "isSummary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleEmbedding" (
    "id" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueryLog" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "articlesRetrieved" INTEGER NOT NULL,
    "confidence" INTEGER NOT NULL,
    "processingTimeMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_url_key" ON "Article"("url");

-- CreateIndex
CREATE INDEX "Article_publishedAt_idx" ON "Article"("publishedAt");

-- CreateIndex
CREATE INDEX "Article_source_idx" ON "Article"("source");

-- CreateIndex
CREATE INDEX "ArticleChunk_articleId_idx" ON "ArticleChunk"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleChunk_articleId_chunkIndex_key" ON "ArticleChunk"("articleId", "chunkIndex");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleEmbedding_chunkId_key" ON "ArticleEmbedding"("chunkId");

-- CreateIndex
CREATE INDEX "article_embedding_idx" ON "ArticleEmbedding" USING hnsw (embedding vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "ArticleChunk" ADD CONSTRAINT "ArticleChunk_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArticleEmbedding" ADD CONSTRAINT "ArticleEmbedding_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "ArticleChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
