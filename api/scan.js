// api/scan.js
export default async function handler(req, res) {
  // GETで疎通確認
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 } to scan" });
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
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY is missing" });
    }

    const model =
      process.env.ANTHROPIC_MODEL ||
      "claude-haiku-4-5"; // ←まずこれ。使えない場合は Vercel env で 20251001 の方に変更してOK

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let j;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
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
                    "画像内の『数字』だけを読み取り、最もそれらしい金額を1つ選んでJSONのみで返して。形式は厳守: {\"total\":14850}。カンマは無視して数値化。見つからなければ {\"total\":0}。",
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      j = await r.json().catch(() => ({}));

      if (!r.ok) {
        return res.status(200).json({
          total: 0,
          debug: {
            where: "anthropic",
            status: r.status,
            message: j?.error?.message || j?.error || "anthropic error",
            model,
          },
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(text);
    const n = sanitizeNumber(parsed?.total);

    return res.status(200).json({ total: n });
  } catch (e) {
    return res.status(200).json({
      total: 0,
      debug: { where: "server", message: String(e?.message || e) },
    });
  }
}

function extractFirstJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}

  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  try {
    return JSON.parse(s.slice(first, last + 1));
  } catch (_) {
    return null;
  }
}

function sanitizeNumber(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[^\d]/g, ""); // カンマ/空白/円など除去
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : 0;
}
