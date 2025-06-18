export async function consumeReadableStream(
  stream: ReadableStream<Uint8Array>,
  callback: (chunk: string) => void,
  signal: AbortSignal
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()

  signal.addEventListener("abort", () => reader.cancel(), { once: true })

  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      if (value) {
        buffer += decoder.decode(value, { stream: true })
        let lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6)
            if (data === "[DONE]") continue
            try {
              const parsed = JSON.parse(data)
              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                callback(parsed.delta.text)
              }
            } catch (e) {
              // Ignore parse errors
            }
          }
        }
      }
    }
  } catch (error) {
    if (signal.aborted) {
      console.error("Stream reading was aborted:", error)
    } else {
      console.error("Error consuming stream:", error)
    }
  } finally {
    reader.releaseLock()
  }
}
