// api/scan.js
export default async function handler(req, res) {
  // 動作確認用
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
      // 画面を赤くしたくないので 200 で返す
      return res.status(200).json({ total: 0, debug: "ANTHROPIC_API_KEY is missing" });
    }

    // タイムアウト
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
          model: "claude-3-haiku",
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
                    media_type: "image/png",
                    data: image_base64,
                  },
                },
                {
                  type: "text",
                  text:
                    "黄色枠内の『数字だけ』を読み取り、最もそれらしい金額を1つだけ返してください。" +
                    "返答はJSONのみ。形式: {\"total\":5400}。" +
                    "カンマ(,)やスペースがあってもよい。数字が無ければ {\"total\":0}。",
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
            message: j?.error?.message || "anthropic error",
          },
        });
      }
    } finally {
      clearTimeout(timeout);
    }

    // テキスト結合
    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // まずJSONとして読みに行く（成功すればそれが最優先）
    const parsed = extractFirstJson(text);
    let total = 0;

    if (parsed && parsed.total != null) {
      total = normalizeMoney(parsed.total);
    } else {
      // JSONじゃなかった場合の保険：文字列から数字だけ抜く
      total = normalizeMoney(text);
    }

    return res.status(200).json({
      total: Number.isFinite(total) ? total : 0,
      raw: text || "",
    });
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

// "5,400" / "5400円" / 5400 → 5400
function normalizeMoney(v) {
  if (v == null) return 0;
  const s = String(v);

  // 数字っぽい塊を拾う（カンマ/スペース許容）
  const m = s.match(/(\d[\d,\s]{0,20}\d|\d+)/);
  if (!m) return 0;

  const digits = m[1].replace(/[^\d]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}
