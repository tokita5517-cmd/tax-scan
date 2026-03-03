// api/scan.js
export default async function handler(req, res) {
  // 動作確認
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 }" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) return res.status(200).json({ total: 0, debug: "image_base64 required" });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY is missing" });

    // モデルは「存在するやつ」を順に試す（404対策）
    const modelsToTry = [
      "claude-haiku-4-5-20251001", // たかちんの表にあったやつ
      "claude-haiku-4-5",          // alias
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-5",
      "claude-opus-4-6"
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let lastErr = null;

    for (const model of modelsToTry) {
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
            max_tokens: 120,
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
                      "画像内の「数字」だけを読み取り、最もそれらしい金額を1つだけ返して。返答はJSONのみ。形式: {\"total\":14850}。見つからなければ {\"total\":0}。",
                  },
                ],
              },
            ],
          }),
          signal: controller.signal,
        });

        const j = await r.json().catch(() => ({}));

        if (!r.ok) {
          lastErr = { status: r.status, message: j?.error?.message || j?.error || "anthropic error", model };
          // 404/400系は次のモデルへ
          continue;
        }

        const text = (j.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("\n")
          .trim();

        const parsed = extractFirstJson(text);
        const total = Number(parsed?.total || 0);

        clearTimeout(timeout);
        return res.status(200).json({ total: Number.isFinite(total) ? total : 0, modelUsed: model });
      } catch (e) {
        lastErr = { message: String(e?.message || e), model };
        continue;
      }
    }

    clearTimeout(timeout);
    return res.status(200).json({ total: 0, debug: { where: "anthropic", ...lastErr } });
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

  try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { return null; }
}
