-- CreateTable
CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationTurn_threadId_createdAt_idx" ON "ConversationTurn"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationTurn_threadId_idx" ON "ConversationTurn"("threadId");
