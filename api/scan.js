export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { image_base64 } = req.body || {};
    if (!image_base64) return res.status(400).json({ error: "image_base64 required" });

    const API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });

    const prompt = `あなたはOCRアシスタントです。
この画像（カメラで切り抜いた一部）から「数字だけ」を読み取り、次のJSONだけを返してください（説明文は禁止）。

【目的】
- 画像内で最も“金額っぽい”数字（大きめの数字、中央付近の数字、カンマ区切りの数字）を1つだけ total に入れる
- 「合計」「税込」「税抜」などの文字は無視してOK。数字だけに集中。

【選び方（優先順位）】
1) カンマ区切りの数字（例: 35,640）
2) 3桁以上の数字（例: 810 / 14850）
3) 上記が複数あるなら「値が大きいもの」または「一番はっきり写っているもの」

【整形】
- total はカンマや記号を除いた整数にする（例: "35,640" → 35640）
- 見つからない場合は total を 0

【出力フォーマット（これ以外禁止）】
{"total": 35640}
`;

    const payload = {
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
                data: image_base64
              }
            },
            { type: "text", text: prompt }
          ]
        }
      ]
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();

    // Claudeの返答テキスト抽出
    const text =
      (data && data.content && data.content[0] && data.content[0].text) ? data.content[0].text : "";

    // JSONだけ抜き出してパース（保険）
    let total = 0;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : JSON.parse(text);
      total = Number(j.total || 0) || 0;
    } catch (e) {
      total = 0;
    }

    return res.status(200).json({ total });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
