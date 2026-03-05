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
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY missing" });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let j = {};
    let responseText = "";

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
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
                    data: image_base64
                  }
                },
                {
                  type: "text",
                  text:
                    [
                      "この画像は請求書の金額欄の一部です。",
                      "画像の中から『金額の数字だけ』を1つ読んでください。",
                      "漢字や記号は無視して、数字だけを返してください。",
                      "カンマ付きはOKです。例: 810 / 5,400 / 14,850 / 35,640",
                      "複数数字が見える場合は、最も大きく、中央付近にある金額を優先してください。",
                      "返答はJSONのみ。説明禁止。",
                      '形式: {"total":14850}',
                      '見つからない場合: {"total":0}'
                    ].join("\n")
                }
              ]
            }
          ]
        }),
        signal: controller.signal
      });

      j = await r.json().catch(() => ({}));

      if (!r.ok) {
        return res.status(200).json({
          total: 0,
          debug: {
            where: "anthropic",
            status: r.status,
            message: j?.error?.message || j?.error || "anthropic error"
          }
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    responseText = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // まずJSONを拾う
    const parsed = extractFirstJson(responseText);
    let total = toPositiveInt(parsed?.total);

    // JSON壊れ対策: 生テキストから数字を拾う
    if (total <= 0) {
      total = pickBestNumber(responseText);
    }

    return res.status(200).json({
      total: total > 0 ? total : 0
    });

  } catch (e) {
    const isAbort = e?.name === "AbortError";
    return res.status(200).json({
      total: 0,
      debug: {
        where: isAbort ? "timeout" : "server",
        message: String(e?.message || e)
      }
    });
  }
}

function toPositiveInt(v) {
  if (typeof v === "number") {
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  }
  if (typeof v !== "string") return 0;

  const s = normalizeDigits(v).replace(/[^\d]/g, "");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeDigits(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[，、]/g, ",");
}

function extractFirstJson(s) {
  if (!s) return null;

  const stripped = String(s)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (_) {}

  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try {
      return JSON.parse(stripped.slice(first, last + 1));
    } catch (_) {}
  }

  const m = stripped.match(/"total"\s*:\s*"?(.*?)"?\s*[,}]/);
  if (m) return { total: m[1] };

  return null;
}

function pickBestNumber(text) {
  if (!text) return 0;

  const s = normalizeDigits(text);

  // 1〜6桁くらいの金額を拾う（カンマあり/なし）
  const matches = [...s.matchAll(/\d{1,3}(?:,\d{3})+|\d{1,6}/g)]
    .map((m) => Number(String(m[0]).replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!matches.length) return 0;

  // 小さすぎる誤読（例 2, 25 など）を減らす
  const filtered = matches.filter((n) => n >= 100) || matches;

  // 基本は最大値優先
  return Math.max(...(filtered.length ? filtered : matches));
}
