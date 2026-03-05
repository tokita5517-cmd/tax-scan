// api/scan.js
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "POST { image_base64 }" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64) {
      return res.status(200).json({ total: 0 });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(200).json({ total: 0 });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    let r;
    let j = {};

    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
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
                    [
                      "画像には数字だけが入っています。",
                      "見えている数字のうち、金額として最も自然な数字を1つだけ選んでください。",
                      "カンマは無視して整数にしてください。",
                      "2桁以下の小さすぎる数字は、他に3桁以上の数字があるなら採用しないでください。",
                      "返答はJSONのみ。説明文は不要です。",
                      '形式: {"total":810}',
                      '見つからなければ {"total":0}'
                    ].join(" "),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      j = await r.json().catch(() => ({}));
    } finally {
      clearTimeout(timeout);
    }

    if (!r || !r.ok) {
      return res.status(200).json({ total: 0 });
    }

    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(text);
    const total = normalizeNumber(parsed?.total);

    return res.status(200).json({
      total: Number.isFinite(total) ? total : 0,
    });
  } catch (e) {
    return res.status(200).json({ total: 0 });
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

function normalizeNumber(v) {
  if (v == null) return 0;

  if (typeof v === "number") return Math.floor(v);

  const s = String(v).replace(/[^\d]/g, "");
  if (!s) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  return Math.floor(n);
}
