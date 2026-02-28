
// api/scan.js

export const config = {
  api: {
    bodyParser: { sizeLimit: "6mb" }, // iPhoneのbase64が大きいので少し余裕
  },
};

export default async function handler(req, res) {
  // POST以外は拒否
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { image_base64 } = req.body || {};
    if (!image_base64 || typeof image_base64 !== "string") {
      return res.status(400).json({ error: "image_base64 required" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY is missing" });
    }

    // Claudeへ
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 220,
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
                  "この画像内の「金額っぽい数字」をできるだけ拾ってください。返答はJSONだけ。\n" +
                  '形式: {"numbers":[1234,35640,...]}\n' +
                  "条件: 1) カンマあり/なしどちらも想定 2) 年月日などの小さい数字は極力除外（ただし金額ならOK） 3) 0は入れない",
              },
            ],
          },
        ],
      }),
    });

    const j = await r.json();

    if (!r.ok) {
      // 返しすぎると見づらいので最低限だけ
      return res.status(500).json({
        error: "anthropic error",
        status: r.status,
        detail: j?.error?.message || j?.message || "unknown",
      });
    }

    // Claudeのtext部分を連結
    const text = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    // JSONを抽出してnumbers取得
    const parsed = extractJson(text) || safeJson(text) || {};
    let numbers = Array.isArray(parsed.numbers) ? parsed.numbers : [];

    // 念のため、テキストからも数字を拾う（Claudeが崩した時の保険）
    if (!numbers.length) {
      numbers = fallbackExtractNumbers(text);
    }

    // 正規化（整数化・範囲・重複除去）
    numbers = normalizeNumbers(numbers);

    // 「合計っぽい」値を1つ決める：基本は最大値（請求書の合計が一番大きい事が多い）
    const total = pickBestTotal(numbers);

    return res.status(200).json({
      found: total > 0,
      total: total || 0,
      numbers,
      raw: undefined, // 必要ならデバッグで text を返すが通常は返さない
    });
  } catch (e) {
    return res.status(500).json({
      error: "server error",
      detail: String(e?.message || e),
    });
  }
}

// ===== helpers =====

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJson(s) {
  // 文字列の中から最初の { ... } を抜く（余計な文字が混ざった時用）
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const chunk = s.slice(first, last + 1);
  return safeJson(chunk);
}

function fallbackExtractNumbers(text) {
  // 例: "35,640" / "35640" の両方拾う
  // ※小さすぎる数字は後でフィルタする
  const re = /(\d{1,3}(?:,\d{3})+|\d{3,})/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function normalizeNumbers(arr) {
  const set = new Set();

  for (const x of arr) {
    const s = String(x).replace(/[^\d,]/g, "");
    if (!s) continue;
    const n = Number(s.replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    if (n <= 0) continue;

    // 金額っぽい下限（100円未満は誤検出が多いので弱めに弾く）
    // ただし「810円」みたいなのもあるので 100 未満だけ落とす
    if (n < 100) continue;

    // 異常に大きいのも落とす（億超えは今回の用途だとほぼ無い想定）
    if (n > 999999999) continue;

    set.add(n);
  }

  return [...set].sort((a, b) => a - b);
}

function pickBestTotal(numbers) {
  if (!numbers || !numbers.length) return 0;

  // 基本は最大値
  let best = numbers[numbers.length - 1];

  // もし「税抜・税・税込」が混ざっていて税込(合計)が一番大きいならそのまま最大でOK
  // ただ、日付(20260228)みたいなのが最大になる事故があるのでガード
  // YYYYMMDD形式っぽい(8桁)は避ける（20200101〜20991231）
  if (best >= 20200101 && best <= 20991231) {
    // 8桁日付を除外して次点を採用
    const filtered = numbers.filter((n) => !(n >= 20200101 && n <= 20991231));
    if (filtered.length) best = filtered[filtered.length - 1];
  }

  return best || 0;
}
