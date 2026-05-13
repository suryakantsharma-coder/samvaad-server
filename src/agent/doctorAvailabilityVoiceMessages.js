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
    messageHindi: `माफ़ कीजिए — ${name} उस तारीख को उपलब्ध नहीं हैं; छुट्टी ${until} तक है। कृपया उसके बाद का कोई दिन बताइए।`,
    messageGujarati: `માફ કરશો — ${name} આ તારીખે ઉપલબ્ધ નથી; રજા ${until} સુધી છે. તે પછીનો કોઈ બીજો દિવસ જણાવશો?`,
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
    messageHindi: `माफ़ कीजिए — ${name} उस समय उपलब्ध नहीं हैं। ये डॉक्टर आमतौर पर इन घंटों में मिलते हैं: ${hours}। कृपया इन्हीं घंटों के अंदर कोई समय बताइए।`,
    messageGujarati: `માફ કરશો — ${name} આ સમયે ઉપલબ્ધ નથી. સામાન્ય રીતે તેમનો સમય આ પ્રમાણે છે: ${hours}. આ જ સમયગાળામાંથી કોઈ સમય પસંદ કરશો?`,
    messageEnglish: `Sorry — ${name} is not available at that time. This doctor is usually available during: ${hours}. Please suggest a time within those hours.`,
  };
}

module.exports = {
  holidayBlockMessages,
  outsideHoursMessages,
};
