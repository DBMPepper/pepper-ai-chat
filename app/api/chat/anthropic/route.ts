import { NextRequest, NextResponse } from "next/server"
import { conversationManager } from "@/lib/services/anthropic-conversation-manager"

export async function POST(request: NextRequest) {
  try {
    const json = await request.json()
    const {
      chatId,
      messages,
      model = "claude-3-5-sonnet-20240620",
      temperature = 0.5,
      max_tokens = 4096,
      system, // System prompt if provided
      stream = true,
      userId
    } = json

    // Robust userId fallback
    let userIdentifier = userId
    if (!userIdentifier) {
      const authorization = request.headers.get("authorization")
      if (authorization) {
        userIdentifier = authorization.replace("Bearer ", "").slice(0, 20)
      }
      if (!userIdentifier) {
        userIdentifier =
          request.headers.get("x-session-id") ||
          request.headers.get("x-forwarded-for") ||
          "anonymous"
      }
    }

    // Validate required fields
    if (!chatId) {
      return NextResponse.json({ error: "chatId is required" }, { status: 400 })
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json(
        { error: "No messages provided" },
        { status: 400 }
      )
    }

    // Set system prompt if provided (from field or first message)
    let systemPrompt = system
    if (!systemPrompt && messages[0]?.role === "system") {
      systemPrompt = messages[0].content
    }
    if (systemPrompt) {
      conversationManager.setSystemPrompt(chatId, systemPrompt)
    }

    // Get the latest user message
    const latestMessage = messages[messages.length - 1]
    // Prepare messages with optimization
    const {
      messages: optimizedMessages,
      includeSystem,
      estimatedTokens,
      systemPrompt: preparedSystemPrompt
    } = conversationManager.prepareApiMessages(chatId, userIdentifier, {
      id: crypto.randomUUID(),
      role: latestMessage.role,
      content: latestMessage.content,
      createdAt: new Date()
    })

    // Build Anthropic API request
    const anthropicRequest: any = {
      model,
      messages: optimizedMessages,
      temperature,
      max_tokens,
      stream
    }
    if (includeSystem && preparedSystemPrompt) {
      console.log("Setting system prompt  ===>")
      anthropicRequest.system = preparedSystemPrompt
    }

    // Make request to Anthropic
    const anthropicResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(anthropicRequest)
      }
    )

    if (!anthropicResponse.ok) {
      const error = await anthropicResponse.text()
      return NextResponse.json(
        { error: `Anthropic API error: ${error}` },
        { status: anthropicResponse.status }
      )
    }

    // Streaming response
    if (stream) {
      const encoder = new TextEncoder()
      const decoder = new TextDecoder()
      let assistantMessage = ""
      let totalOutputTokens = 0
      const transformStream = new TransformStream({
        async transform(chunk, controller) {
          controller.enqueue(chunk)
          const text = decoder.decode(chunk, { stream: true })
          const lines = text.split("\n")
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6)
              if (data === "[DONE]") continue
              try {
                const parsed = JSON.parse(data)
                if (
                  parsed.type === "content_block_delta" &&
                  parsed.delta?.text
                ) {
                  assistantMessage += parsed.delta.text
                  totalOutputTokens = Math.ceil(assistantMessage.length / 4)
                }
              } catch (e) {}
            }
          }
        },
        async flush(controller) {
          if (assistantMessage) {
            conversationManager.updateSessionAfterResponse(
              chatId,
              userIdentifier,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: assistantMessage,
                createdAt: new Date()
              },
              {
                input_tokens: estimatedTokens,
                output_tokens: totalOutputTokens
              },
              model
            )
            const stats = conversationManager.getSessionStats(
              chatId,
              userIdentifier
            )
            if (stats) {
              const statsEvent = encoder.encode(
                `data: ${JSON.stringify({ type: "session_stats", stats })}\n\n`
              )
              controller.enqueue(statsEvent)
            }
          }
        }
      })
      return new Response(
        anthropicResponse.body!.pipeThrough(transformStream),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          }
        }
      )
    } else {
      // Non-streaming response
      const data = await anthropicResponse.json()
      if (data.content && data.content[0]) {
        conversationManager.updateSessionAfterResponse(
          chatId,
          userIdentifier,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.content[0].text,
            createdAt: new Date()
          },
          {
            input_tokens: estimatedTokens,
            output_tokens: Math.ceil(data.content[0].text.length / 4)
          },
          model
        )
      }
      const stats = conversationManager.getSessionStats(chatId, userIdentifier)
      return NextResponse.json({ ...data, sessionStats: stats })
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: "Internal server error", details: error.message },
      { status: 500 }
    )
  }
}

// GET endpoint for session stats
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const chatId = searchParams.get("chatId")
  const userId = searchParams.get("userId") || "anonymous"
  if (!chatId) {
    return NextResponse.json({ error: "chatId is required" }, { status: 400 })
  }
  const stats = conversationManager.getSessionStats(chatId, userId)
  const sessionCount = conversationManager.getActiveSessionCount()
  return NextResponse.json({ stats, activeSessionsTotal: sessionCount })
}
