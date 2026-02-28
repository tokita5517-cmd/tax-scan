// api/scan.js
export default async function handler(req, res) {
  // キャッシュさせない（地味に効く）
  res.setHeader("Cache-Control", "no-store");

  // GETで動作確認
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
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY is missing" });
    }

    // Anthropic呼び出し（タイムアウト付き）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let j;
    let httpStatus = 0;

    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-haiku-20240307",
          max_tokens: 180,
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
                    [
                      "画像の中から『合計』『合計金額』『ご請求金額』『税込』『お支払い金額』などの合計額と思われる数字を1つだけ選んでください。",
                      "カンマや円記号が付いていてもOK。返す total は整数（カンマ無し）にして。",
                      '返答はJSONだけ。形式は厳守: {"total": 35640}。見つからない場合は {"total": 0}。',
                    ].join("\n"),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      httpStatus = r.status;
      j = await r.json().catch(() => ({}));

      // 失敗でもアプリ側を荒らさない（total:0）
      if (!r.ok) {
        return res.status(200).json({
          total: 0,
          debug: {
            where: "anthropic",
            status: httpStatus,
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

    // 1) JSON抽出をまず試す
    const parsed = extractFirstJson(text);
    let total = normalizeToInt(parsed?.total);

    // 2) JSONが壊れてたら、テキストから数字を拾って保険
    if (!total) {
      total = pickLikelyTotalFromText(text);
    }

    return res.status(200).json({
      total: Number.isFinite(total) ? total : 0,
      // デバッグしたい時だけ見る用（邪魔なら消してOK）
      // debug: { raw: text },
    });
  } catch (e) {
    return res.status(200).json({
      total: 0,
      debug: { where: "server", message: String(e?.message || e) },
    });
  }
}

// --- helpers ---
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

function normalizeToInt(v) {
  if (v == null) return 0;
  const s = String(v);
  // 数字以外を除去（例: "1,234円" -> "1234"）
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return 0;
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

function pickLikelyTotalFromText(text) {
  if (!text) return 0;

  // "合計 12,340" みたいな近接パターン優先
  const near = [
    /合計[^\d]{0,10}([\d,]{1,12})/g,
    /ご請求金額[^\d]{0,10}([\d,]{1,12})/g,
    /お支払い金額[^\d]{0,10}([\d,]{1,12})/g,
    /税込[^\d]{0,10}([\d,]{1,12})/g,
  ];

  for (const re of near) {
    const m = re.exec(text);
    if (m && m[1]) {
      const n = normalizeToInt(m[1]);
      if (n) return n;
    }
  }

  // それでもダメなら、登場する数値の中で一番大きいのを採用（合計っぽい）
  const all = text.match(/[\d,]{1,12}/g) || [];
  let best = 0;
  for (const x of all) {
    const n = normalizeToInt(x);
    if (n > best) best = n;
  }
  return best;
}
