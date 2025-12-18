require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { OpenAI } = require('openai');
const path = require('path');

const app = express();

const PORT = Number(process.env.PORT) || 3000;

// Chat model (your interviewer brain)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// TTS model + defaults
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'coral'; // try: alloy, coral, nova, onyx, shimmer, etc.
const OPENAI_TTS_SPEED = Number(process.env.OPENAI_TTS_SPEED || '1.0');

if (!process.env.SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET missing in .env');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY missing in .env');
  process.exit(1);
}

app.use(express.json({ limit: '1mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 60 * 60 * 1000, // 1 hour
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    }
  })
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PERSONALITIES = [
  'stern and no-nonsense',
  'friendly but probing',
  'dryly sarcastic',
  'warm and encouraging',
  'highly critical'
];

function getRandomPersonality() {
  return PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
}

function extractJson(str) {
  const match = str.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

function wordsCount(s) {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function secondsLeft(req) {
  const endTime = req.session.start_time + req.session.duration_seconds * 1000;
  const now = Date.now();
  return Math.max(0, Math.floor((endTime - now) / 1000));
}

async function summarizeOld(history) {
  if (history.length === 0) return '';

  const block = history
    .map(
      (h) =>
        `Q: ${h.question}\nA: ${h.answer}\nWeakness: ${h.weakness || 'Analyzing...'}`
    )
    .join('\n\n');

  const prompt =
    `Summarize the following earlier interview exchanges (questions, answers, weaknesses) ` +
    `in two brief sentences, focusing on overall strengths and weaknesses:\n\n${block}`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5
  });

  return resp.choices[0].message.content.trim();
}

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

/**
 * OpenAI TTS endpoint (returns mp3 audio)
 * Docs: POST /v1/audio/speech, model gpt-4o-mini-tts, voices like alloy/coral/nova/onyx/shimmer/etc. :contentReference[oaicite:1]{index=1}
 */
app.post('/api/tts', async (req, res) => {
  try {
    const textRaw = String(req.body?.text ?? '').trim();
    if (!textRaw) return res.status(400).json({ error: 'text required' });

    // API reference max input length is 4096 chars. :contentReference[oaicite:2]{index=2}
    const text = textRaw.length > 4096 ? textRaw.slice(0, 4096) : textRaw;

    const voice = String(req.body?.voice || OPENAI_TTS_VOICE).trim();
    const speed = Number.isFinite(Number(req.body?.speed))
      ? Number(req.body.speed)
      : OPENAI_TTS_SPEED;

    // Make the voice match the interview personality (optional, but helps realism)
    const personality = req.session?.personality || 'professional';
    const instructions =
      String(req.body?.instructions || '').trim() ||
      `Speak like a ${personality} interviewer. Natural pacing, slight pauses, not robotic.`;

    const mp3 = await openai.audio.speech.create({
      model: OPENAI_TTS_MODEL,
      voice,
      input: text,
      instructions,      // supported for gpt-4o-mini-tts :contentReference[oaicite:3]{index=3}
      speed,             // 0.25–4.0 :contentReference[oaicite:4]{index=4}
      response_format: 'mp3'
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// Start interview
app.post('/api/start', (req, res) => {
  const { type, resume, duration } = req.body;

  if (!type || !resume || !duration || isNaN(duration) || duration <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  req.session.profile = { type, resume };
  req.session.duration_seconds = parseInt(duration, 10) * 60;
  req.session.start_time = Date.now();
  req.session.personality = getRandomPersonality();
  req.session.history = [];
  req.session.current_question = null;

  res.json({ success: true });
});

// Get next question
app.get('/api/next-question', async (req, res) => {
  if (!req.session.profile) {
    return res.status(400).json({ error: 'Interview not started' });
  }

  const now = Date.now();
  const endTime = req.session.start_time + req.session.duration_seconds * 1000;

  // If time is up, do not start a new question (client may still submit the current one).
  if (now >= endTime && req.session.history.length > 0 && !req.session.current_question) {
    return res.json({ end: true });
  }

  const timeRemaining = secondsLeft(req);
  const resumeText = req.session.profile.resume || '';
  const typeText = req.session.profile.type || '';

  // Heuristic: if the profile is very short / vague, ask clarifying questions early.
  const profileSparse = wordsCount(resumeText) < 60 || wordsCount(typeText) < 2;

  const messages = [
    {
      role: 'system',
      content:
        `You are a ${req.session.personality} interviewer running a TIMED interview.\n` +
        `Interview type: ${typeText}\n` +
        `Time remaining: ${timeRemaining} seconds.\n\n` +
        `You must ask EXACTLY ONE question at a time.\n\n` +
        `Behavior rules:\n` +
        `- If the candidate profile/answers are missing critical details needed to interview well (target role/title, level/seniority, location, availability, goals, key experience), ask a concise clarifying question first.\n` +
        `- If time remaining is short (<= 120 seconds), ask ONLY the single highest-impact missing detail.\n` +
        `- If the last answer was vague or lacked specifics (see weaknesses), ask a focused follow-up for details.\n` +
        `- Otherwise, ask a professional, role-relevant interview question based on the candidate's resume and prior answers.\n` +
        `- Avoid multi-part questions unless absolutely necessary.\n\n` +
        `Output ONLY a JSON object with a single field: "question". No extra text.`
    },
    {
      role: 'user',
      content:
        `Candidate profile (resume / notes):\n${resumeText}\n\n` +
        `Hint: profile_sparse=${profileSparse}`
    }
  ];

  if (req.session.history.length > 0) {
    if (req.session.history.length > 5) {
      const oldSummary = await summarizeOld(req.session.history.slice(0, -5));
      messages.push({
        role: 'user',
        content: `Brief summary of earlier exchanges:\n${oldSummary}`
      });
    }

    const last5 = req.session.history.slice(-5);
    const block = last5
      .map(
        (h) =>
          `Q: ${h.question}\nA: ${h.answer}\nWeakness: ${h.weakness || 'Analyzing...'}`
      )
      .join('\n\n');

    messages.push({ role: 'user', content: `Last five Q&A and weaknesses:\n${block}` });
  }

  messages.push({ role: 'user', content: 'Ask the next question now.' });

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.7
    });

    const raw = resp.choices[0].message.content.trim();
    const json = extractJson(raw);
    const question = json.question || 'Tell me about yourself.';

    req.session.current_question = question;
    req.session.current_question_started_at = Date.now();

    res.json({ question });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate question' });
  }
});

// Submit answer
app.post('/api/submit-answer', async (req, res) => {
  if (!req.session.profile || !req.session.current_question) {
    return res.status(400).json({ error: 'Invalid state' });
  }

  const { answer } = req.body;
  if (!answer || answer.trim() === '') {
    return res.status(400).json({ error: 'Answer required' });
  }

  const item = {
    question: req.session.current_question,
    answer: answer.trim(),
    weakness: 'Analyzing...',
    askedAt: req.session.current_question_started_at || null,
    answeredAt: Date.now(),
    source: 'speech_to_text'
  };

  req.session.history.push(item);

  // Weakness analysis (best-effort, async)
  (async () => {
    try {
      const prompt =
        `Question: ${item.question}\nAnswer: ${item.answer}\n\n` +
        `In one sentence, what is the key weakness of this answer?`;

      const resp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6
      });

      const weakness = resp.choices[0].message.content.trim();

      const idx = req.session.history.findIndex(
        (h) => h.question === item.question && h.answer === item.answer
      );
      if (idx !== -1) {
        req.session.history[idx].weakness = weakness;
        req.session.save(() => {});
      }
    } catch (err) {
      console.error('Weakness analysis failed:', err);
    }
  })();

  req.session.current_question = null;
  req.session.current_question_started_at = null;

  const now = Date.now();
  const endTime = req.session.start_time + req.session.duration_seconds * 1000;
  const time_up = now >= endTime;

  res.json({ time_up });
});

// Transcript
app.get('/api/transcript', (req, res) => {
  if (!req.session.profile) {
    return res.status(400).json({ error: 'Interview not started' });
  }
  res.json({
    profile: req.session.profile,
    personality: req.session.personality,
    startedAt: req.session.start_time,
    durationSeconds: req.session.duration_seconds,
    history: req.session.history || []
  });
});

// Final result
app.get('/api/result', async (req, res) => {
  if (!req.session.history || req.session.history.length === 0) {
    return res.status(400).json({ error: 'No interview data' });
  }

  const data = {
    q: req.session.history.map((h) => h.question),
    a: req.session.history.map((h) => h.answer),
    w: req.session.history.map((h) => h.weakness || 'N/A')
  };

  const prompt =
    `Based on these Q&A and weaknesses:\n${JSON.stringify(data)}\n\n` +
    `Return ONLY a JSON object with:\n` +
    `  status: "Success" or "Fail",\n` +
    `  confidence: integer 0–100,\n` +
    `  reason: string (only if status is "Fail").\n` +
    `Be as brief as possible.`;

  try {
    const resp = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5
    });

    const raw = resp.choices[0].message.content;
    const result = extractJson(raw);

    res.json({
      status: result.status || 'Fail',
      confidence: result.confidence ?? 0,
      reason: result.reason || '',
      history: req.session.history
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute result' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
