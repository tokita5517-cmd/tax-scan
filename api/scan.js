// /api/scan.js  ── 修正版
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

    // 🔧 Fix: 画像サイズ上限チェック（約1.5MB）
    if (image_base64.length > 2_000_000) {
      return res.status(413).json({ error: "image too large" });
    }

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return res.status(200).json({ total: 0, text: "", debug: "ANTHROPIC_API_KEY is missing" });
    }

    // 🔧 Fix: タイムアウトを8秒に短縮（260msループと整合）
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

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
          // 🔧 Fix: 最新Haikuに変更（日本語OCR精度向上）
          model: "claude-3-5-haiku-20241022",
          max_tokens: 180,
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
                  // 🔧 Fix: プロンプトを大幅改善
                  //   - 画像内の文字を全部抽出するよう指示
                  //   - 合計キーワードがなくても数字だけでも返す
                  //   - JSON形式の指示を明確化・例を複数追加
                  //   - 「見つからなくても数字があれば返す」を追加
                  text: `あなたは注文書・請求書のOCRアシスタントです。
この画像（カメラで切り抜いた一部）から文字を読み取り、以下のJSONのみを返してください。

【この書類の特徴】
- 「合　計　⇒」のように漢字の間にスペースが入る
- 黒背景に白文字で「合　計　⇒」と印字される場合がある
- 金額は「5,400」「810」「45,630」のようにカンマ区切りまたは3桁以上の数字

【抽出ルール】
1. 画像内の文字をすべてtextに入れる（改行は半角スペースに変換）
2. 「合計」「合　計」「請求金額」「お支払金額」などの右側・近くにある数字をtotalに入れる
3. スペースを無視して「合計」が読み取れたらその隣の数字を優先
4. 数字はカンマなしの整数で返す（5,400→5400）
5. 画像に数字が1つしかなければそれをtotalに入れる

返答はJSON一行のみ。説明・コードブロック不要。

例1: {"text":"合 計 ⇒ 5,400","total":5400}
例2: {"text":"合　計　⇒ 810","total":810}
例3: {"text":"合計 ⇒ 45,630 消費税・地方消費税 請求金額","total":45630}
例4: {"text":"270","total":270}
例5: {"text":"","total":0}`,
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

    // レスポンステキスト取得
    const rawText = (j.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();

    const parsed = extractFirstJson(rawText) || {};
    const text = typeof parsed.text === "string" ? parsed.text : rawText;

    // 🔧 Fix: totalの取得優先順位を明確化
    let total = toInt(parsed.total);

    // JSONからtotalが取れなかった場合、textから正規表現で抽出
    if (total <= 0 && text) {
      total = pickNumberFromText(text);
    }

    return res.status(200).json({ total: total > 0 ? total : 0, text });

  } catch (e) {
    // AbortErrorはタイムアウト
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

// ─── ユーティリティ ────────────────────────────────────────────────

/**
 * 文字列または数値を整数に変換
 * カンマ区切り・￥記号・全角数字に対応
 */
function toInt(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const s = String(v)
    .replace(/[，、,]/g, "")          // カンマ除去（全角含む）
    .replace(/[¥￥\$€£]/g, "")       // 通貨記号除去
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)) // 全角数字→半角
    .replace(/[^\d.]/g, "");          // 数字以外除去
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * JSONを文字列から安全に抽出
 * コードブロック・前後テキストも処理
 */
function extractFirstJson(s) {
  if (!s) return null;

  // コードブロック除去
  const stripped = s.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();

  // まずそのままパース
  try { return JSON.parse(stripped); } catch (_) {}

  // { } の範囲を探す
  const first = stripped.indexOf("{");
  const last  = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;

  const chunk = stripped.slice(first, last + 1);
  try { return JSON.parse(chunk); } catch (_) {}

  // 🔧 Fix: キーだけ正規表現で抽出（JSONが壊れていても救出）
  return extractByRegex(stripped);
}

/**
 * 正規表現でtextとtotalを個別抽出（JSON破損時の最終手段）
 */
function extractByRegex(s) {
  const textMatch  = s.match(/"text"\s*:\s*"([^"]*)"/);
  const totalMatch = s.match(/"total"\s*:\s*(\d+)/);
  if (!textMatch && !totalMatch) return null;
  return {
    text:  textMatch  ? textMatch[1]  : "",
    total: totalMatch ? Number(totalMatch[1]) : 0,
  };
}

/**
 * テキストから金額らしい数字を抽出
 * 「合　計」のようなスペース区切りキーワードにも対応
 */
function pickNumberFromText(text) {
  if (!text) return 0;

  // 全角数字→半角
  const normalized = text.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
  // スペース除去版（「合　計　⇒」のようなキーワードマッチ用）
  const compact = normalized.replace(/[\s\u3000]/g, "");

  // 合計キーワードの直後にある数字を優先（スペース除去版で検索）
  const keywordMatch = compact.match(
    /(?:合計|請求金額|ご請求|お支払|税込)[^\d]*(\d{1,3}(?:,\d{3})*|\d+)/
  );
  if (keywordMatch) {
    const n = Number(keywordMatch[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  // カンマ区切りの数字（1,000以上）
  const commaMatch = normalized.match(/\d{1,3}(?:,\d{3})+/);
  if (commaMatch) {
    const n = Number(commaMatch[0].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }

  // 3桁以上の数字
  const plainMatch = normalized.match(/\d{3,}/);
  if (plainMatch) {
    const n = Number(plainMatch[0]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // 2桁以上（270円など3桁未満も対応）
  const smallMatch = normalized.match(/\d{2,}/);
  if (smallMatch) {
    const n = Number(smallMatch[0]);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 0;
}
