/**
 * API endpoints for conversation history management
 */

import { Router } from 'express';
import {
  listConversations,
  getConversation,
  deleteConversation,
} from '../utils/conversation-store';

const router = Router();

/**
 * GET /api/conversations
 * List all conversations (for sidebar)
 */
router.get('/', async (_req, res) => {
  try {
    const conversations = await listConversations();
    res.json({ conversations });
  } catch (error) {
    console.error('Error listing conversations:', error);
    res.status(500).json({
      error: 'Failed to list conversations',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * GET /api/conversations/:threadId
 * Get a single conversation by threadId
 */
router.get('/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    const turns = await getConversation(threadId);

    if (turns.length === 0) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    res.json({
      threadId,
      turns: turns.map(t => ({
        role: t.role,
        content: t.content,
        sources: t.sources,
        createdAt: t.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error('Error fetching conversation:', error);
    res.status(500).json({
      error: 'Failed to fetch conversation',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/**
 * DELETE /api/conversations/:threadId
 * Delete a conversation by threadId
 */
router.delete('/:threadId', async (req, res) => {
  try {
    const { threadId } = req.params;
    await deleteConversation(threadId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({
      error: 'Failed to delete conversation',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
