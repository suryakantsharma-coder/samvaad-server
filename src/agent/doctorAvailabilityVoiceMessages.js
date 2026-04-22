/**
 * Bilingual (Hindi + Gujarati) lines for the voice agent when a slot is invalid.
 * Matches WhatsApp booking semantics (holiday + usual hours).
 */

function escapeForSpeech(name) {
  return String(name || "").trim() || "डॉक्टर";
}

/**
 * @param {string} doctorName
 * @param {string} endLabel — e.g. "15 Apr 2026" (IST)
 */
function holidayBlockMessages(doctorName, endLabel) {
  const name = escapeForSpeech(doctorName);
  const until = String(endLabel || "").trim() || "उपयुक्त तारीख";
  return {
    messageHindi: `क्षमा करें — ${name} उस तारीख को उपलब्ध नहीं हैं। छुट्टी ${until} तक है। कृपया इस तारीख के बाद कोई और दिन चुनें।`,
    messageGujarati: `માફ કરશો — ${name} તે તારીખે ઉપલબ્ધ નથી. રજા ${until} સુધી છે. કૃપા કરીને આ તારીખ પછી બીજો દિવસ પસંદ કરો.`,
    messageEnglish: `Sorry — ${name} is not available on that date (leave until ${until}). Please choose a day after that.`,
  };
}

/**
 * @param {string} doctorName
 * @param {string} hoursLabel — sanitized availability text (may be English)
 */
function outsideHoursMessages(doctorName, hoursLabel) {
  const name = escapeForSpeech(doctorName);
  const hours = String(hoursLabel || "").trim() || "9 AM - 5 PM";
  return {
    messageHindi: `क्षमा करें — ${name} उस समय उपलब्ध नहीं हैं। यह डॉक्टर आमतौर पर इन समय में मिलते हैं: ${hours}. कृपया इन घंटों के भीतर कोई समय बताइए।`,
    messageGujarati: `માફ કરશો — ${name} તે સમયે ઉપલબ્ધ નથી. આ ડૉક્ટર સામાન્ય રીતે આ સમયમાં મળે છે: ${hours}. કૃપા કરીને આ સમયની અંદર સમય જણાવો.`,
    messageEnglish: `Sorry — ${name} is not available at that time. This doctor is usually available during: ${hours}. Please suggest a time within those hours.`,
  };
}

module.exports = {
  holidayBlockMessages,
  outsideHoursMessages,
};
