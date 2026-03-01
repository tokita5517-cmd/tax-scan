// /api/scan.js
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 } to scan" });
  }
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
      return res.status(200).json({ total: 0, text: "", debug: "ANTHROPIC_API_KEY is missing" });
    }

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
          model: "claude-3-haiku-20240307",
          max_tokens: 220,
          temperature: 0,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/jpeg", data: image_base64 },
                },
                {
                  type: "text",
                  text:
                    [
                      "あなたはOCR補助です。",
                      "画像(切り抜き)の中にある文字をできるだけそのまま1行で書き出してください（改行なし）。",
                      "そして、その中から合計金額（合計/合計金額/請求金額/ご請求金額/お支払い金額/税込 など）の右側にある数字を1つ選んで total に入れてください。",
                      "必ず JSON だけを返してください。形式厳守：",
                      '{"text":"合計 5,400","total":5400}',
                      "見つからなければ：",
                      '{"text":"","total":0}',
                    ].join("\n"),
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
          text: "",
          debug: { where: "anthropic", status: r.status, message: j?.error?.message || "anthropic error" },
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    const rawText = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(rawText) || {};
    const text = typeof parsed.text === "string" ? parsed.text : "";

    let total = Number(parsed.total || 0);
    if (!Number.isFinite(total) || total <= 0) {
      total = pickNumberFromText(text);
    }

    return res.status(200).json({ total: total > 0 ? total : 0, text });
  } catch (e) {
    return res.status(200).json({
      total: 0,
      text: "",
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
  const chunk = s.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) { return null; }
}

function pickNumberFromText(text) {
  if (!text) return 0;
  const m = text.match(/\d{1,3}(?:,\d{3})+|\d{3,}/);
  if (!m) return 0;
  const n = Number(String(m[0]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
