// 发音：优先播放在线词典原声，拿不到就用系统语音合成。
// accent: "uk" 英音 / "us" 美音

const AUDIO_URL = "https://dict.youdao.com/dictvoice?audio=";
const audioCache = new Map();

function playUrl(url, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const a = audioCache.get(url) || new Audio();
    audioCache.set(url, a);
    let settled = false;
    const done = (v, ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.onerror = null;
      a.oncanplay = null;
      ok ? resolve(v) : reject(v);
    };
    const timer = setTimeout(() => done(new Error("timeout"), false), timeout);
    a.onerror = () => done(new Error("audio error"), false);
    a.oncanplay = () => {
      a.play().then(() => done(true, true)).catch((e) => done(e, false));
    };
    a.src = url;
    a.load();
  });
}

function pickVoice(lang) {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  if (!voices.length) return null;
  const want = lang.toLowerCase();
  return (
    voices.find((v) => (v.lang || "").toLowerCase().replace("_", "-") === want) ||
    voices.find((v) => (v.lang || "").toLowerCase().startsWith(want.slice(0, 2))) ||
    null
  );
}

function speakWithTts(word, accent) {
  if (!window.speechSynthesis) return false;
  const lang = accent === "uk" ? "en-GB" : "en-US";
  const u = new SpeechSynthesisUtterance(word);
  u.lang = lang;
  u.rate = 0.95;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return true;
}

// 返回 "audio" 表示播的是词典原声，"tts" 表示用的系统语音，null 表示都没成
export async function speak(word, accent) {
  const w = String(word || "").trim();
  if (!w) return null;

  const type = accent === "uk" ? 1 : 2;
  try {
    await playUrl(AUDIO_URL + encodeURIComponent(w) + "&type=" + type);
    return "audio";
  } catch (err) {
    /* 网络不通或被拦，转到系统语音 */
  }
  return speakWithTts(w, accent) ? "tts" : null;
}

// 提前把声音列表唤醒，某些浏览器第一次 getVoices 是空的
export function warmVoices() {
  if (!window.speechSynthesis) return;
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}
