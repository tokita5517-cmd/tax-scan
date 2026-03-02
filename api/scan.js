// /api/scan.js (Vercel Serverless Function)
// Env: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ error: "Bad Request: missing image dataURL" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });

    const m = image.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "Bad Request: invalid dataURL" });
    const mediaType = m[1];
    const b64 = m[2];

    const prompt = [
      "You are reading a photo of a small rectangular area containing a Japanese invoice amount.",
      "Return ONLY the number you can see (digits and optional comma).",
      "Do not include currency symbols, words, spaces, or any other characters.",
      "If you cannot confidently read a number, return an empty string."
    ].join("\n");

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 64,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
              { type: "text", text: prompt }
            ]
          }
        ]
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: data?.error || data || "Anthropic error" });
    }

    const text = (data?.content || [])
      .filter((c) => c?.type === "text")
      .map((c) => c.text)
      .join("")
      .trim();

    const cleaned = (text || "")
      .replace(/[￥¥]/g, "")
      .replace(/[^0-9,]/g, "")
      .trim();

    const num = cleaned ? Number(cleaned.replace(/,/g, "")) : 0;

    return res.status(200).json({
      text: cleaned,
      total: Number.isFinite(num) ? num : 0
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
