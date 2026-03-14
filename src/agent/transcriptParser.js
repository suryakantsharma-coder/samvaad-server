/**
 * Parse appointment-related details from call transcript (for logging).
 */

function parseAppointmentFromTranscript(callTranscript, callerPhone) {
  const fullText = callTranscript.map((t) => t.text).join(" ");
  if (!fullText) return null;

  const hospitalMatches = [...fullText.matchAll(/\bHospital\s+([AB])\b/gi)];
  const hospital = hospitalMatches.length
    ? `Hospital ${hospitalMatches[hospitalMatches.length - 1][1].toUpperCase()}`
    : null;

  const drMatch = fullText.match(/\bDr\.\s+([A-Za-z\s]+?)(?:\s+\(|,|\.|$)/);
  const doctorName = drMatch ? drMatch[1].trim() : null;

  let patientName =
    fullText.match(/\bpatient\s+([A-Za-z]+)\s*(?:,|\.|\s+age)/i)?.[1] ||
    fullText
      .match(
        /(?:patient|मरीज|રોગી)[\s:]+([A-Za-z\u0900-\u0DFF\s]+?)(?:\s*[,.]|\s+age|\s+उम्र|$)/i,
      )?.[1]
      ?.trim() ||
    fullText
      .match(/(?:patient|Patient):\s*([A-Za-z\s]+?)(?:\s*[,.]|\s+age|$)/i)?.[1]
      ?.trim() ||
    fullText.match(
      /(?:confirmed for|with)\s+([A-Za-z]+)\s*(?:,|\.|age)/i,
    )?.[1] ||
    null;
  if (patientName) patientName = patientName.replace(/\s+/g, " ").trim();

  const ageMatch =
    fullText.match(/(?:age|उम्र|ઉંમર)[\s:]*(\d{1,3})/i) ||
    fullText.match(/(\d{1,3})\s*(?:years?\s+old|साल|વર્ષ)/i) ||
    fullText.match(/\bage[:\s]+(\d{1,3})\b/i);
  const patientAge = ageMatch ? parseInt(ageMatch[1], 10) : null;

  const dateMatch =
    fullText.match(
      /(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?/i,
    ) ||
    fullText.match(
      /\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)/i,
    ) ||
    fullText.match(
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}/i,
    );
  const preferredDate = dateMatch ? dateMatch[0].trim() : null;

  const timeMatch =
    fullText.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i) ||
    fullText.match(/(?:at|time)\s+(\d{1,2})\s*(?:AM|PM)/i);
  const preferredTime = timeMatch ? timeMatch[1].trim() : null;

  if (
    !hospital &&
    !doctorName &&
    !patientName &&
    !patientAge &&
    !preferredDate &&
    !preferredTime
  )
    return null;

  return {
    hospital,
    doctorName,
    patientName: patientName || null,
    patientAge,
    phone: callerPhone !== "unknown" ? callerPhone : null,
    preferredDate,
    preferredTime,
    callEndedAt: new Date().toISOString(),
  };
}

module.exports = { parseAppointmentFromTranscript };
