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
      return res.status(200).json({ total: 0, debug: { where: "input", message: "image_base64 required" } });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(200).json({ total: 0, debug: { where: "env", message: "ANTHROPIC_API_KEY is missing" } });
    }

    // タイムアウト
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let j = {};
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
          // ✅ 404回避で “表にあるモデル” を使う
          // （あなたの画像の「Claude API ID / Alias」に合わせた）
          model: "claude-haiku-4-5",
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
`あなたはOCRです。
画像内の「数字（税抜金額）」を1つだけ返してください。
- 枠内の数字だけを対象にする（他は無視）
- カンマあり/なし両方OK
- 3〜7桁を優先
返答はJSONのみ。形式厳守：{"total":14850}
見つからない場合：{"total":0}`,
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
    const total = normalizeNumber(parsed?.total);

    return res.status(200).json({ total: total });
  } catch (e) {
    return res.status(200).json({
      total: 0,
      debug: { where: "server", message: String(e?.message || e) },
    });
  }
}

function normalizeNumber(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
  if (typeof v === "string") {
    const s = v.replace(/[^\d]/g, "");
    if (!s) return 0;
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  return 0;
}

function extractFirstJson(s) {
  if (!s) return null;

  // ```json ... ``` を剥がす
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) s = fenced[1].trim();

  // そのままJSON
  try { return JSON.parse(s); } catch (_) {}

  // 最初の { ... } を抜く
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const chunk = s.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) { return null; }
}
