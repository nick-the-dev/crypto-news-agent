export function buildUserPrompt(context: string, question: string): string {
  return `${context}

---

QUESTION: ${question}

Remember to cite sources [1], [2], [3] for every claim. Follow the response format exactly.`;
}
