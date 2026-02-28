// api/scan.js
export default async function handler(req, res) {
  // GETで動作確認できるように
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 } to scan" });
  }

  // POST以外は弾く
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(400).json({ error: "image_base64 required" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      // ここはユーザー側に分かりやすく
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY is missing" });
    }

    // Anthropic呼び出し（タイムアウト付き）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

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
          // ✅ まず確実に動くモデルにする（ここが重要）
          model: "claude-3-haiku-20240307",
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
                    "画像の中から『合計』『合計金額』『ご請求金額』『税込』『お支払い金額』などの合計額と思われる数字を1つだけ選び、JSONだけで返してください。形式は厳守: {\"total\": 35640}。見つからない場合は {\"total\": 0}。",
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      j = await r.json().catch(() => ({}));

      // 失敗でもアプリ側を赤エラーにしたくないので 200 + total:0 で返す
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

    // Claudeの返答テキストを結合
    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(text);
    const total = Number(parsed?.total || 0);

    return res.status(200).json({ total: Number.isFinite(total) ? total : 0 });
  } catch (e) {
    // AbortError含め、ここも 200 で返して画面を荒らさない
    return res.status(200).json({
      total: 0,
      debug: { where: "server", message: String(e?.message || e) },
    });
  }
}

// --- helpers ---
function extractFirstJson(s) {
  if (!s) return null;

  // そのままJSONならOK
  try {
    return JSON.parse(s);
  } catch (_) {}

  // 最初の { ... } を抜く（保険）
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
