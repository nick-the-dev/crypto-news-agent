import { prisma } from './db';
import { Source } from '../schemas';
import { debugLogger } from './debug-logger';

export interface StoredTurn {
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
  createdAt: Date;
}

export interface ConversationContext {
  threadId: string;
  turns: StoredTurn[];
  lastSources: Source[] | null;
  lastAnswer: string | null;
}

export interface ConversationSummary {
  threadId: string;
  title: string;
  lastMessage: string;
  createdAt: Date;
  updatedAt: Date;
}

const MAX_TURNS = 20;
const MAX_CONTENT_LENGTH = 4000;

/**
 * Save a user turn to the conversation history
 */
export async function saveUserTurn(threadId: string, content: string): Promise<void> {
  const stepId = debugLogger.stepStart('CONV_STORE', 'Saving user turn', { threadId });
  try {
    await prisma.conversationTurn.create({
      data: {
        threadId,
        role: 'user',
        content: content.substring(0, MAX_CONTENT_LENGTH),
      },
    });
    debugLogger.stepFinish(stepId, { success: true });
  } catch (error) {
    debugLogger.stepError(stepId, 'CONV_STORE', 'Failed to save user turn', error);
    // Don't throw - conversation storage shouldn't break the main flow
  }
}

/**
 * Save an assistant turn to the conversation history
 */
export async function saveAssistantTurn(
  threadId: string,
  content: string,
  sources?: Source[]
): Promise<void> {
  const stepId = debugLogger.stepStart('CONV_STORE', 'Saving assistant turn', { threadId });
  try {
    await prisma.conversationTurn.create({
      data: {
        threadId,
        role: 'assistant',
        content: content.substring(0, MAX_CONTENT_LENGTH),
        sources: sources ? JSON.parse(JSON.stringify(sources)) : undefined,
      },
    });
    debugLogger.stepFinish(stepId, { success: true });
  } catch (error) {
    debugLogger.stepError(stepId, 'CONV_STORE', 'Failed to save assistant turn', error);
    // Don't throw - conversation storage shouldn't break the main flow
  }
}

/**
 * Load conversation context for a thread
 */
export async function getConversationContext(threadId: string): Promise<ConversationContext> {
  const stepId = debugLogger.stepStart('CONV_STORE', 'Loading conversation context', { threadId });

  try {
    const turns = await prisma.conversationTurn.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      take: MAX_TURNS,
    });

    const storedTurns: StoredTurn[] = turns.map(t => ({
      role: t.role as 'user' | 'assistant',
      content: t.content,
      sources: t.sources as Source[] | undefined,
      createdAt: t.createdAt,
    }));

    // Find the last assistant turn for sources
    const lastAssistantTurn = [...storedTurns]
      .reverse()
      .find(t => t.role === 'assistant');

    debugLogger.stepFinish(stepId, {
      turnsFound: storedTurns.length,
      hasLastSources: !!lastAssistantTurn?.sources,
    });

    return {
      threadId,
      turns: storedTurns,
      lastSources: lastAssistantTurn?.sources || null,
      lastAnswer: lastAssistantTurn?.content || null,
    };
  } catch (error) {
    debugLogger.stepError(stepId, 'CONV_STORE', 'Failed to load context', error);
    return { threadId, turns: [], lastSources: null, lastAnswer: null };
  }
}

/**
 * Get a single conversation by threadId
 */
export async function getConversation(threadId: string): Promise<StoredTurn[]> {
  const turns = await prisma.conversationTurn.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
  });

  return turns.map(t => ({
    role: t.role as 'user' | 'assistant',
    content: t.content,
    sources: t.sources as Source[] | undefined,
    createdAt: t.createdAt,
  }));
}

/**
 * List all conversations (for sidebar)
 */
export async function listConversations(limit = 50): Promise<ConversationSummary[]> {
  // Get distinct threadIds with their first and last messages
  const threads = await prisma.$queryRaw<Array<{
    threadId: string;
    firstMessage: string;
    lastMessage: string;
    createdAt: Date;
    updatedAt: Date;
  }>>`
    WITH thread_info AS (
      SELECT
        "threadId",
        MIN("createdAt") as "createdAt",
        MAX("createdAt") as "updatedAt"
      FROM "ConversationTurn"
      GROUP BY "threadId"
      ORDER BY MAX("createdAt") DESC
      LIMIT ${limit}
    ),
    first_messages AS (
      SELECT DISTINCT ON (ct."threadId")
        ct."threadId",
        ct.content as "firstMessage"
      FROM "ConversationTurn" ct
      INNER JOIN thread_info ti ON ct."threadId" = ti."threadId"
      WHERE ct.role = 'user'
      ORDER BY ct."threadId", ct."createdAt" ASC
    ),
    last_messages AS (
      SELECT DISTINCT ON (ct."threadId")
        ct."threadId",
        ct.content as "lastMessage"
      FROM "ConversationTurn" ct
      INNER JOIN thread_info ti ON ct."threadId" = ti."threadId"
      ORDER BY ct."threadId", ct."createdAt" DESC
    )
    SELECT
      ti."threadId",
      fm."firstMessage",
      lm."lastMessage",
      ti."createdAt",
      ti."updatedAt"
    FROM thread_info ti
    LEFT JOIN first_messages fm ON ti."threadId" = fm."threadId"
    LEFT JOIN last_messages lm ON ti."threadId" = lm."threadId"
    ORDER BY ti."updatedAt" DESC
  `;

  return threads.map(t => ({
    threadId: t.threadId,
    // Use first user message as title, truncated
    title: (t.firstMessage || 'New conversation').substring(0, 100),
    lastMessage: t.lastMessage || '',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }));
}

/**
 * Delete a conversation by threadId
 */
export async function deleteConversation(threadId: string): Promise<void> {
  await prisma.conversationTurn.deleteMany({
    where: { threadId },
  });
}

/**
 * Format conversation context for LLM prompt
 */
export function formatContextForPrompt(context: ConversationContext, maxTokens = 4000): string {
  // Estimate tokens: ~4 chars per token
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  let totalTokens = 0;
  const formattedTurns: string[] = [];

  // Always include first turn if exists (sets topic context)
  if (context.turns.length > 0) {
    const first = context.turns[0];
    const firstFormatted = `${first.role.toUpperCase()}: ${first.content}`;
    totalTokens += estimateTokens(firstFormatted);
    formattedTurns.push(firstFormatted);
  }

  // Add remaining turns from the end, respecting token limit
  for (let i = context.turns.length - 1; i >= 1; i--) {
    const turn = context.turns[i];
    const formatted = `${turn.role.toUpperCase()}: ${turn.content}`;
    const tokens = estimateTokens(formatted);

    if (totalTokens + tokens > maxTokens) {
      // Add truncation marker
      if (formattedTurns.length > 1) {
        formattedTurns.splice(1, 0, '... [earlier messages truncated] ...');
      }
      break;
    }

    totalTokens += tokens;
    formattedTurns.splice(1, 0, formatted); // Insert after first turn
  }

  return formattedTurns.join('\n\n');
}
