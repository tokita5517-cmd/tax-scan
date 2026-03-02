export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const image = body?.image;

    if (!image || typeof image !== "string") {
      return res.status(400).json({ error: "Missing image" });
    }

    // dataURL -> base64
    const base64 = image.includes(",") ? image.split(",")[1] : image;

    // Claude 4.5/4.6系のID（たかちんの画面の表に合わせる）
    // 迷ったら haiku をデフォに（速い＆安い）
    const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

    const system = [
      "You are an OCR extractor for Japanese invoices.",
      "The input is an image crop containing a single total amount (tax excluded).",
      "Extract ONLY the number amount.",
      "Return ONLY JSON in the exact format: {\"total\": <integer>}.",
      "If you cannot confidently read a number, return {\"total\": 0}.",
      "Do not include commas, currency symbols, or any other keys.",
    ].join("\n");

    const payload = {
      model,
      max_tokens: 40,
      temperature: 0,
      system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64,
              },
            },
            {
              type: "text",
              text: "Read the amount and respond with JSON only.",
            },
          ],
        },
      ],
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: "Anthropic error", detail: text });
    }

    const data = JSON.parse(text);
    const outText =
      data?.content?.map((c) => (c?.type === "text" ? c.text : "")).join("\n") || "";

    // JSONだけ抜く（保険）
    const m = outText.match(/\{[\s\S]*\}/);
    let obj = null;
    if (m) {
      try {
        obj = JSON.parse(m[0]);
      } catch (_) {}
    }

    const total = Number(obj?.total || 0);
    if (!Number.isFinite(total) || total < 0) return res.status(200).json({ total: 0 });

    return res.status(200).json({ total: Math.trunc(total) });
  } catch (e) {
    return res.status(500).json({ error: "Server error", detail: String(e) });
  }
}
