// Vercel 서버리스 함수: POST /api/generate  (Gemini만 쓰는 버전)
// 환경변수: GEMINI_API_KEY 하나만 필요
// 도서관 데이터 없이 Gemini가 직접 그림책을 추천함 → 실제로 없는 책이 섞일 수 있음

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const MAX_RESULTS = 5;

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function clean(text, max) {
  const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function buildPrompt(keyword) {
  return (
    `당신은 어린이 그림책 전문 사서 "책탐정 코난"입니다.\n` +
    `사용자 키워드: "${keyword}"\n\n` +
    `이 키워드와 어울리는, 한국어로 출간된 그림책 ${MAX_RESULTS}권을 추천해 주세요.\n\n` +
    `규칙:\n` +
    `- 실제로 출간된 책만 알려 주세요. 확실하지 않은 정보는 지어내지 말고 빈 문자열("")로 두세요.\n` +
    `- 각 책은 title(제목), author(저자), publisher(출판사), summary(줄거리와 추천 이유 2~3문장)를 포함합니다.\n` +
    `- 반드시 아래 JSON 형식만 출력하세요. 설명 문장이나 코드블록은 쓰지 마세요.\n` +
    `{"books":[{"title":"","author":"","publisher":"","summary":""}]}`
  );
}

function parseBooks(text) {
  const parsed = JSON.parse(String(text || "").replace(/```json|```/gi, "").trim());
  const list = Array.isArray(parsed.books) ? parsed.books : [];
  return list
    .filter((b) => b && typeof b.title === "string" && b.title.trim())
    .slice(0, MAX_RESULTS)
    .map((b) => ({
      title: clean(b.title, 80),
      author: clean(b.author, 60),
      publisher: clean(b.publisher, 60),
      summary: clean(b.summary, 280),
      cover: "" // 이 버전은 표지 이미지가 없음
    }));
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 사용할 수 있어요." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res
      .status(500)
      .json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았어요." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const keyword = String((body && body.keyword) || "").trim().slice(0, 50);
  if (!keyword) {
    return res.status(400).json({ error: "키워드를 입력해 주세요." });
  }

  try {
    const r = await fetchWithTimeout(
      GEMINI_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: buildPrompt(keyword) }] }],
          generationConfig: {
            temperature: 0.4,
            responseMimeType: "application/json"
          }
        })
      },
      9000
    );

    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error("Gemini error:", r.status, detail);
      return res.status(502).json({ error: `AI 서버 오류 (${r.status}): ${detail}` });
    }

    const data = await r.json();
    const parts =
      (data.candidates && data.candidates[0] && data.candidates[0].content &&
        data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");

    let books;
    try {
      books = parseBooks(text);
    } catch (e) {
      console.error("parse failed:", text.slice(0, 300));
      return res.status(502).json({ error: "AI 답을 읽지 못했어요. 다시 검색해 주세요." });
    }
    if (!books.length) {
      return res.status(200).json({
        books: [],
        aiUsed: true,
        aiNote: "AI가 어울리는 책을 찾지 못했어요. 다른 키워드로 해 보세요."
      });
    }

    return res.status(200).json({
      books,
      aiUsed: true,
      aiNote: "AI가 고른 책이에요. 실제로 있는 책인지 한 번 확인해 보세요."
    });
  } catch (err) {
    console.error("generate error:", err.message);
    const msg = err.name === "AbortError"
      ? "AI 답이 늦어지고 있어요. 잠시 후 다시 시도해 주세요."
      : "AI에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.";
    return res.status(502).json({ error: msg });
  }
};
