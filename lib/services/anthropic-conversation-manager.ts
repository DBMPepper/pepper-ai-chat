// lib/services/anthropic-conversation-manager.ts
// No database required - pure in-memory implementation

interface Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  createdAt: Date
}

interface ConversationSession {
  messages: Message[]
  initialized: boolean
  totalInputTokens: number
  totalOutputTokens: number
  totalCost: number
  createdAt: Date
  lastActivity: Date
}

interface SessionStats {
  messageCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalTokens: number
  totalCost: string
  duration: number
  initialized: boolean
}

export class AnthropicConversationManager {
  private sessions: Map<string, ConversationSession>
  private systemPrompts: Map<string, string>

  // Token pricing for Claude models
  private pricing: Record<string, { input: number; output: number }> = {
    "claude-3-5-sonnet-20240620": {
      input: 0.003 / 1000,
      output: 0.015 / 1000
    },
    "claude-3-opus-20240229": {
      input: 0.015 / 1000,
      output: 0.075 / 1000
    },
    "claude-3-haiku-20240307": {
      input: 0.00025 / 1000,
      output: 0.00125 / 1000
    }
  }

  constructor() {
    this.sessions = new Map()
    this.systemPrompts = new Map()

    // Optional: Clean up old sessions periodically (every hour)
    setInterval(() => this.cleanupOldSessions(), 3600000)
  }

  // Set system prompt for a specific conversation
  setSystemPrompt(chatId: string, prompt: string) {
    this.systemPrompts.set(chatId, prompt)
  }

  // Get system prompt for a conversation
  getSystemPrompt(chatId: string): string {
    return this.systemPrompts.get(chatId) || ""
  }

  // Initialize or get session
  getSession(chatId: string, userId: string): ConversationSession {
    const sessionKey = `${userId}-${chatId}`

    if (!this.sessions.has(sessionKey)) {
      console.log("Creating new session===>", sessionKey)
      this.sessions.set(sessionKey, {
        messages: [],
        initialized: false,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        createdAt: new Date(),
        lastActivity: new Date()
      })
    }

    return this.sessions.get(sessionKey)!
  }

  // Estimate tokens (rough approximation)
  private estimateTokens(text: string): number {
    // More accurate estimation:
    // - Average English word: ~1.3 tokens
    // - Average character: ~0.25 tokens
    // We'll use character count / 4 as a reasonable approximation
    return Math.ceil(text.length / 4)
  }

  // Calculate message tokens
  private calculateMessageTokens(
    messages: any[],
    includeSystem: boolean,
    chatId: string
  ): number {
    let tokens = 0

    // System prompt tokens (only on first message)
    if (includeSystem) {
      const systemPrompt = this.getSystemPrompt(chatId)
      tokens += this.estimateTokens(systemPrompt)
    }

    // Message tokens
    for (const msg of messages) {
      tokens += this.estimateTokens(msg.content)
      tokens += 4 // Role tokens
    }

    // Add some overhead for message formatting
    tokens += messages.length * 3

    return tokens
  }

  // Prepare messages for API call
  prepareApiMessages(
    chatId: string,
    userId: string,
    newMessage: Message
  ): {
    messages: any[]
    includeSystem: boolean
    estimatedTokens: number
    systemPrompt?: string
  } {
    const session = this.getSession(chatId, userId)
    // console.log("Existing session",session);
    console.log("Existing session Messages", session.messages.length)
    console.log("Existing session Initialized", session.initialized)
    console.log("Existing session Total Input Tokens", session.totalInputTokens)
    console.log(
      "Existing session Total Output Tokens",
      session.totalOutputTokens
    )
    console.log("Existing session Total Cost", session.totalCost)
    console.log("Existing session Last Activity", session.lastActivity)

    // Add new message to session
    session.messages.push(newMessage)
    session.lastActivity = new Date()

    // Convert to Anthropic format
    const apiMessages = session.messages
      .filter(msg => msg.role !== "system") // Remove system messages from history
      .map(msg => ({
        role: msg.role === "user" ? "user" : "assistant",
        content: msg.content
      }))

    // Check if we need to optimize history
    const currentTokens = this.calculateMessageTokens(
      apiMessages,
      !session.initialized,
      chatId
    )
    console.log("currentTokens", currentTokens)
    console.log("session.initialized", session.initialized)

    if (currentTokens > 3000 && session.messages.length > 10) {
      this.optimizeHistory(session, chatId)
      // Recalculate messages after optimization
      const optimizedMessages = session.messages
        .filter(msg => msg.role !== "system")
        .map(msg => ({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content
        }))

      return {
        messages: optimizedMessages,
        includeSystem: !session.initialized,
        estimatedTokens: this.calculateMessageTokens(
          optimizedMessages,
          !session.initialized,
          chatId
        ),
        systemPrompt: !session.initialized
          ? this.getSystemPrompt(chatId)
          : undefined
      }
    }

    return {
      messages: apiMessages,
      includeSystem: !session.initialized,
      estimatedTokens: currentTokens,
      systemPrompt: !session.initialized
        ? this.getSystemPrompt(chatId)
        : undefined
    }
  }

  // Update session after API response
  updateSessionAfterResponse(
    chatId: string,
    userId: string,
    assistantMessage: Message,
    usage?: {
      input_tokens: number
      output_tokens: number
    },
    model: string = "claude-3-5-sonnet-20240620"
  ) {
    const session = this.getSession(chatId, userId)

    // Add assistant message
    session.messages.push(assistantMessage)
    session.initialized = true
    session.lastActivity = new Date()
    console.log("Initialising Session", session)

    // Update token counts if provided
    if (usage) {
      session.totalInputTokens += usage.input_tokens
      session.totalOutputTokens += usage.output_tokens

      // Calculate cost
      if (this.pricing[model]) {
        const inputCost = usage.input_tokens * this.pricing[model].input
        const outputCost = usage.output_tokens * this.pricing[model].output
        session.totalCost += inputCost + outputCost
      }
    }
  }

  // Optimize conversation history
  private optimizeHistory(session: ConversationSession, chatId: string) {
    if (session.messages.length <= 6) return

    // Keep first exchange (for context) and last 4 messages
    const firstUserMsg = session.messages.find(m => m.role === "user")
    const firstAssistantMsg = session.messages.find(m => m.role === "assistant")
    const recentMessages = session.messages.slice(-4)
    const middleMessages = session.messages.slice(2, -4)

    // Create a summary of middle messages
    const summary = this.createSummary(middleMessages)

    // Reconstruct optimized message history
    const optimizedMessages: Message[] = []

    if (firstUserMsg) optimizedMessages.push(firstUserMsg)
    if (firstAssistantMsg) optimizedMessages.push(firstAssistantMsg)

    // Add summary as a system message
    optimizedMessages.push({
      id: "summary-" + Date.now(),
      role: "system",
      content: `Previous conversation summary: ${summary}`,
      createdAt: new Date()
    })

    optimizedMessages.push(...recentMessages)

    session.messages = optimizedMessages
  }

  // Create summary of messages
  private createSummary(messages: Message[]): string {
    const keyPoints: string[] = []
    const topics = new Set<string>()

    messages.forEach(msg => {
      // Extract key sentences (first 100 chars of each message)
      if (msg.content.length > 50) {
        const preview = msg.content.substring(0, 100).trim()
        keyPoints.push(`${msg.role}: ${preview}...`)
      }

      // Extract potential topics (simple keyword extraction)
      const words = msg.content.toLowerCase().split(/\s+/)
      words.forEach(word => {
        if (
          word.length > 6 &&
          !["the", "and", "for", "that", "this", "with"].includes(word)
        ) {
          topics.add(word)
        }
      })
    })

    const topicList = Array.from(topics).slice(0, 5).join(", ")
    return `Discussed ${messages.length} messages about: ${topicList}. Key points: ${keyPoints.slice(0, 3).join(" | ")}`
  }

  // Get session statistics
  getSessionStats(chatId: string, userId: string): SessionStats | null {
    const session = this.getSession(chatId, userId)

    if (!session || session.messages.length === 0) return null

    return {
      messageCount: session.messages.filter(m => m.role !== "system").length,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalTokens: session.totalInputTokens + session.totalOutputTokens,
      totalCost: session.totalCost.toFixed(4),
      duration: Math.round(
        (Date.now() - session.createdAt.getTime()) / 1000 / 60
      ), // minutes
      initialized: session.initialized
    }
  }

  // Clear specific session
  clearSession(chatId: string, userId: string) {
    const sessionKey = `${userId}-${chatId}`
    this.sessions.delete(sessionKey)
    this.systemPrompts.delete(chatId)
  }

  // Clear all sessions for a user
  clearUserSessions(userId: string) {
    const keysToDelete: string[] = []
    this.sessions.forEach((_, key) => {
      if (key.startsWith(userId + "-")) {
        keysToDelete.push(key)
      }
    })
    keysToDelete.forEach(key => this.sessions.delete(key))
  }

  // Clean up old sessions (called periodically)
  private cleanupOldSessions() {
    const threeHourAgo = new Date(Date.now() - 10800000)
    const keysToDelete: string[] = []

    this.sessions.forEach((session, key) => {
      if (session.lastActivity < threeHourAgo) {
        keysToDelete.push(key)
        // Also clean up associated system prompts
        const chatId = key.split("-")[1]
        if (chatId) {
          this.systemPrompts.delete(chatId)
        }
      }
    })

    keysToDelete.forEach(key => this.sessions.delete(key))

    if (keysToDelete.length > 0) {
      console.log(`Cleaned up ${keysToDelete.length} inactive sessions`)
    }
  }

  // Get active session count (for monitoring)
  getActiveSessionCount(): number {
    return this.sessions.size
  }

  // Export session data (for debugging or analytics)
  exportSession(chatId: string, userId: string): any {
    const session = this.getSession(chatId, userId)
    const stats = this.getSessionStats(chatId, userId)

    return {
      session: {
        messages: session.messages,
        created: session.createdAt,
        lastActivity: session.lastActivity
      },
      stats,
      systemPromptLength: this.getSystemPrompt(chatId).length
    }
  }
}

// Export singleton instance
export const conversationManager = new AnthropicConversationManager()

// Optional: Export the class if you want to create multiple instances
export default AnthropicConversationManager
