/**
 * Queue audio message strings.
 * Hospital name is read from QUEUE_HOSPITAL_NAME env var (fallback: "our hospital").
 */

function hospitalName() {
  return (process.env.QUEUE_HOSPITAL_NAME || '').trim() || 'our hospital';
}

/**
 * Bilingual welcome — Hindi first, then English.
 * Played once when the caller is placed in the queue.
 */
function getWelcomeMessage() {
  const name = hospitalName();
  const hindi =
    `नमस्ते! ${name} में कॉल करने के लिए धन्यवाद। ` +
    `अभी हमारे सभी agents व्यस्त हैं। ` +
    `जैसे ही कोई agent उपलब्ध होगा, हम तुरंत आपको connect करेंगे। ` +
    `आपके सहयोग के लिए धन्यवाद।`;
  const english =
    `Thank you for calling ${name}. ` +
    `All our agents are currently attending to other callers. ` +
    `You will be connected to the next available agent shortly. ` +
    `We appreciate your patience and cooperation.`;
  return `${hindi} ${english}`;
}

const WAITING = {
  hi: [
    'आपकी call हमारे लिए important है। एक agent जल्द ही आपसे बात करेंगे। Please hold.',
    'धन्यवाद आपकी प्रतीक्षा के लिए। हम जल्द ही आपसे connect करेंगे।',
    'आप अभी भी queue में हैं। थोड़ी और प्रतीक्षा करें — हम जल्द ही आपसे मिलेंगे।',
  ],
  en: [
    'Your call is important to us. An agent will be with you shortly. Please continue to hold.',
    'Thank you for your patience. You will be connected to an agent shortly.',
    'You are still in the queue. Please hold on — we will be with you soon.',
  ],
};

const CONNECTING = {
  hi: 'धन्यवाद प्रतीक्षा के लिए। अभी आपको connect कर रहे हैं।',
  en: 'Thank you for waiting. Connecting you to an agent now.',
};

const TIMEOUT = {
  hi: 'क्षमा करें, अभी हम आपकी call नहीं ले पा रहे हैं। कृपया कुछ समय बाद call करें।',
  en: 'We are sorry, we are unable to take your call right now. Please call again later.',
};

const QUEUE_FULL = {
  hi: 'क्षमा करें, अभी हमारी queue full है। कृपया कुछ मिनट बाद call करें।',
  en: 'We are sorry, our queue is currently full. Please call back in a few minutes.',
};

/**
 * Bilingual reassurance — Hindi then English.
 * Played every QUEUE_REASSURANCE_INTERVAL_SECONDS while the caller waits.
 */
function getReassuranceMessage() {
  const hindi   = 'कृपया लाइन पर बने रहें। आपकी कॉल हमारे लिए महत्वपूर्ण है। आपको शीघ्र ही प्रतिनिधि से जोड़ा जाएगा।';
  const english = 'Please stay on the line. Your call is important to us. You will be connected to a representative shortly.';
  return `${hindi} ${english}`;
}

function getWaitingMessage(lang = 'hi', attempt = 0) {
  const msgs = WAITING[lang] || WAITING.hi;
  return msgs[attempt % msgs.length];
}

function getConnectingMessage(lang = 'hi') {
  return CONNECTING[lang] || CONNECTING.hi;
}

function getTimeoutMessage(lang = 'hi') {
  return TIMEOUT[lang] || TIMEOUT.hi;
}

function getQueueFullMessage(lang = 'hi') {
  return QUEUE_FULL[lang] || QUEUE_FULL.hi;
}

function getPositionMessage(position, lang = 'hi') {
  if (lang === 'en') return `You are number ${position} in the queue. Please hold.`;
  return `आप queue में ${position} number पर हैं। कृपया प्रतीक्षा करें।`;
}

module.exports = {
  getWelcomeMessage,
  getReassuranceMessage,
  getWaitingMessage,
  getConnectingMessage,
  getTimeoutMessage,
  getQueueFullMessage,
  getPositionMessage,
};
