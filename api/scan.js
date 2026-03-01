// /api/scan.js  ── 数字だけ抽出版（強化版：sonnet + 数字JSON直返し）
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

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(200).json({ total: 0, text: "", debug: "ANTHROPIC_API_KEY is missing" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);

    let j = {};
    let status = 0;

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
          // ★小さい数字用に sonnet 推奨
          model: "claude-3-5-sonnet-20241022",
          max_tokens: 120,
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
                  text: `
この画像（黄色枠の切り抜き）に写っている「金額の数字」を読み取ってください。

ルール:
- 数字は1つだけ選ぶ（カンマは無視してOK）
- 迷ったら「一番それっぽい金額（通常は最大値）」を返す
- 読めなければ 0

返す形式はJSONだけ（説明禁止）:
{"total":5400,"text":"読めた断片（任意）"}
`.trim(),
                },
              ],
            },
          ],
        }),
        signal: controller.signal,
      });

      status = r.status;
      j = await r.json().catch(() => ({}));

      if (!r.ok) {
        return res.status(200).json({
          total: 0,
          text: "",
          debug: { where: "anthropic", status, message: j?.error?.message || "anthropic error" },
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
    const total = Number(parsed?.total || 0);
    const text = typeof parsed?.text === "string" ? parsed.text : rawText;

    // もしモデルが total を返せてなくても、textから保険抽出
    const finalTotal = Number.isFinite(total) && total > 0 ? total : pickBestNumber(text);

    return res.status(200).json({
      total: finalTotal > 0 ? finalTotal : 0,
      text: text || "",
      debug: finalTotal > 0 ? "" : `empty_or_unreadable (status:${status})`,
    });
  } catch (e) {
    const isTimeout = e?.name === "AbortError";
    return res.status(200).json({
      total: 0,
      text: "",
      debug: { where: isTimeout ? "timeout" : "server", message: isTimeout ? "request timed out" : String(e?.message || e) },
    });
  }
}

// ---- helpers ----
function extractFirstJson(s) {
  if (!s) return null;
  const stripped = s.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  try { return JSON.parse(stripped); } catch (_) {}

  const first = stripped.indexOf("{");
  const last  = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  const chunk = stripped.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) {}

  return null;
}

function pickBestNumber(text) {
  if (!text) return 0;

  const normalized = String(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[¥￥]/g, "");

  const matches = normalized.match(/\d{1,3}(?:,\d{3})+|\d{2,}/g) || [];
  const nums = matches
    .map((s) => Number(String(s).replace(/,/g, "")))
    .filter((n) => Number.isFinite(n))
    .filter((n) => n >= 10 && n < 10_000_000);

  if (!nums.length) return 0;
  return Math.max(...nums);
}
