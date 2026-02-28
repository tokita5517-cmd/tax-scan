// api/scan.js
export default async function handler(req, res) {
  try {
    // ✅ iPhoneで /api/scan を開いた時に確認できるようGETもOKにする
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "POST image_base64 to scan" });
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 required" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is missing" });
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // ✅ ここがポイント：安定モデルに変更
        model: "claude-3-haiku-20240307",
        max_tokens: 200,
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
                  "画像内の金額っぽい数字を読み取り、最もそれらしい『合計金額（税込）』を1つだけ返して。返答はJSONのみ。形式: {\"total\":35640}（見つからなければ {\"total\":0}）",
              },
            ],
          },
        ],
      }),
    });

    const j = await r.json();

    // ❌ エラー時：理由がわかるようにそのまま返す（Vercel logsで見れる）
    if (!r.ok) {
      return res.status(500).json({
        error: "anthropic error",
        status: r.status,
        detail: j,
      });
    }

    // Claudeの返答テキストを結合
    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // JSONだけ返す想定だが、念のため最初のJSONを抽出してparse
    const parsed = extractFirstJson(text);
    const total = Number(parsed?.total || 0);

    return res.status(200).json({ total: Number.isFinite(total) ? total : 0 });
  } catch (e) {
    return res.status(500).json({ error: "server error", message: String(e?.message || e) });
  }
}

// --- helpers ---
function extractFirstJson(s) {
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
