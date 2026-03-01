// /api/scan.js  ── 数字だけ抽出版（合計キーワード判定なし）
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

    // 画像サイズ上限（base64なので少し余裕みて）
    if (image_base64.length > 2_200_000) {
      return res.status(200).json({ total: 0, text: "", debug: "image too large" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      // アプリ側を壊さないため 200 で返す
      return res.status(200).json({ total: 0, text: "", debug: "ANTHROPIC_API_KEY is missing" });
    }

    // タイムアウト（AUTOループ用）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

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
          model: "claude-3-5-haiku-20241022",
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
                  text: `
あなたはOCRです。
この画像に写っている文字をできるだけ正確に読み取り、次のJSONだけを返してください（説明不要）。

返す形式（厳守）:
{"text":"ここに読み取れた文字を1行で（改行→半角スペース）"}

注意:
- 数字・カンマ・￥なども含めて、見えたまま入れてOK
- 文字が読めなければ {"text":""}
`.trim(),
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

    // ★ここがポイント：合計ワードは見ないで、数字だけからベストを選ぶ
    const total = pickBestNumber(text);

    return res.status(200).json({ total, text });
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

// Claudeの返答から最初のJSONを抜く（壊れてても救う）
function extractFirstJson(s) {
  if (!s) return null;
  const stripped = s.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  try { return JSON.parse(stripped); } catch (_) {}

  const first = stripped.indexOf("{");
  const last  = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  const chunk = stripped.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) {}

  // 最終手段： "text":"..." だけ抜く
  const m = stripped.match(/"text"\s*:\s*"([\s\S]*?)"\s*}/);
  if (m) return { text: m[1] };
  return null;
}

// 文字列から「一番それっぽい金額」を数字だけで決める
function pickBestNumber(text) {
  if (!text) return 0;

  // 全角→半角、通貨記号を少し掃除
  const normalized = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[¥￥]/g, "");

  // 例: 45,630 / 5400 / 810 / 270
  const matches = normalized.match(/\d{1,3}(?:,\d{3})+|\d{2,}/g) || [];
  const nums = matches
    .map((s) => Number(String(s).replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));

  if (!nums.length) return 0;

  // “日付っぽい 20260301” みたいなのが混ざる可能性があるので弾く
  //  - 8桁以上は基本捨てる（必要なら緩められる）
  const filtered = nums.filter((n) => n >= 10 && n < 10_000_000);

  const pool = filtered.length ? filtered : nums;

  // ROIが合計周りなら「最大値」がほぼ合計になるので最大を採用
  const best = Math.max(...pool);
  return best > 0 ? best : 0;
}
