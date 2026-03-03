// /api/scan.js
export default async function handler(req, res) {
  // GET: 動作確認用
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 }" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(200).json({ total: 0, debug: "image_base64 required" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY missing" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let r, j;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: JSON.stringify({
          // ★ あなたのスクショに写ってた「Claude API ID」を使う（404防止）
          model: "claude-haiku-4-5-20251001",
          max_tokens: 80,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/jpeg",
                    data: image_base64,
                  },
                },
                {
                  type: "text",
                  text:
                    "画像の中にある金額（数字）を1つだけ選んで返してください。税抜金額が最優先。返答はJSONだけ。形式は厳守: {\"total\": 14850}。見つからなければ {\"total\": 0}。数字はカンマ無しの整数。",
                },
              ],
            },
          ],
        }),
      });

      j = await r.json().catch(() => ({}));

      if (!r.ok) {
        return res.status(200).json({
          total: 0,
          debug: {
            where: "anthropic",
            status: r.status,
            message: j?.error?.message || j?.error || "anthropic error",
          },
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    // 返答テキストを結合
    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(text);
    const raw = parsed?.total;

    // 数字化（"14,850" みたいなのも安全に処理）
    const n = Number(String(raw ?? "").replace(/[^\d]/g, "")) || 0;

    return res.status(200).json({ total: Number.isFinite(n) ? n : 0 });
  } catch (e) {
    return res.status(200).json({
      total: 0,
      debug: { where: "server", message: String(e?.message || e) },
    });
  }
}

function extractFirstJson(s) {
  if (!s) return null;

  try {
    return JSON.parse(s);
  } catch (_) {}

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const chunk = s.slice(first, last + 1);
  try {
    return JSON.parse(chunk);
  } catch (_) {
    return null;
  }
}
