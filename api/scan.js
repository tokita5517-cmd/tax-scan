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
    if (!image_base64) return res.status(400).json({ error: "image_base64 required" });

    // サイズ上限（base64は膨らむので余裕見て）
    if (image_base64.length > 2_500_000) {
      return res.status(413).json({ error: "image too large" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(200).json({ total: 0, text: "", debug: "ANTHROPIC_API_KEY is missing" });
    }

    // たかちんの表にある「Claude API ID」を使う
    // Haiku 4.5: claude-haiku-4-5-20251001
    // Sonnet 4.5: claude-sonnet-4-5-20250929
    // Opus 4.6:  claude-opus-4-6
    const MODEL_ID = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

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
          model: MODEL_ID,
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
                  text: `あなたはOCRです。画像は「金額だけ」が写っている切り抜きです。

【最重要ルール】
- 画像内に数字が1つでも読めたら、それを total に入れてください。
- 「合計」などの文字は無視してOK。数字が最優先。
- 返答は JSON 1行のみ。説明禁止。

【出力形式】
{"text":"（読めた文字をそのまま）","total":12345}

【整形ルール】
- カンマや￥は除去して整数（例 5,400 → 5400）
- 読めない場合だけ total=0

例: {"text":"35,640","total":35640}
例: {"text":"810","total":810}
例: {"text":"","total":0}`,
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
          debug: {
            where: "anthropic",
            status: r.status,
            message: j?.error?.message || "anthropic error",
            model: MODEL_ID,
          },
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
    const text = typeof parsed.text === "string" ? parsed.text : rawText;

    let total = toInt(parsed.total);
    if (total <= 0 && text) total = pickNumberFromText(text);

    return res.status(200).json({ total: total > 0 ? total : 0, text });

  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    return res.status(200).json({
      total: 0,
      text: "",
      debug: {
        where: isTimeout ? "timeout" : "server",
        message: isTimeout ? "request timed out" : String(e?.message || e),
      },
    });
  }
}

// ---- utils ----
function toInt(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;

  const s = String(v)
    .replace(/[，、,]/g, "")
    .replace(/[¥￥]/g, "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, "");

  const n = Math.round(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function extractFirstJson(s) {
  if (!s) return null;

  const stripped = s.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  try { return JSON.parse(stripped); } catch (_) {}

  const first = stripped.indexOf("{");
  const last  = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  const chunk = stripped.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) {}

  const textMatch  = stripped.match(/"text"\s*:\s*"([^"]*)"/);
  const totalMatch = stripped.match(/"total"\s*:\s*(\d+)/);
  if (!textMatch && !totalMatch) return null;

  return {
    text:  textMatch  ? textMatch[1] : "",
    total: totalMatch ? Number(totalMatch[1]) : 0,
  };
}

function pickNumberFromText(text) {
  const normalized = String(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  const commaMatch = normalized.match(/\d{1,3}(?:,\d{3})+/);
  if (commaMatch) return Number(commaMatch[0].replace(/,/g, ""));

  const plainMatch = normalized.match(/\d{2,}/);
  if (plainMatch) return Number(plainMatch[0]);

  return 0;
}
