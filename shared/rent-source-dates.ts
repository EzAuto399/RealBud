/** Per-property source-date facts for rent evidence review.
 * Observation/extract time is never inferred across properties. */
export interface PropertySourceDates {
  propertyId: string;
  /** Address fragments or tenancy labels used to locate the property in prose. */
  labels: string[];
  /** Bank/PMS extract as-of time if that property actually supplied one; otherwise null. */
  extractObservationAt: string | null;
}

export interface BorrowedObservationIssue {
  propertyId: string;
  borrowedObservation: string;
  detail: string;
}

const EXTRACT_TIME_RE =
  /\b(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}:\d{2})\b/gi;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function clauseMentions(clause: string, labels: readonly string[]): boolean {
  const hay = normalize(clause);
  return labels.some((label) => {
    const needle = normalize(label);
    return needle.length >= 3 && hay.includes(needle);
  });
}

/** Split a draft into small clauses so shared lists stay local to one claim. */
function clausesAround(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, text.lastIndexOf(".", matchIndex - 1) + 1);
  const endCandidates = [text.indexOf(".", matchIndex + matchLength), text.indexOf(";", matchIndex + matchLength)].filter(
    (i) => i >= 0,
  );
  const end = endCandidates.length ? Math.min(...endCandidates) : text.length;
  return text.slice(start, end + 1);
}

/**
 * Detects when prose attributes an extract/as-of clock time to a property
 * that did not supply that observation time. Transaction dates alone are not
 * extract observation times.
 */
export function findBorrowedExtractObservations(
  draft: string,
  properties: readonly PropertySourceDates[],
): BorrowedObservationIssue[] {
  if (!draft.trim() || !properties.length) return [];
  const issues: BorrowedObservationIssue[] = [];
  const seen = new Set<string>();
  for (const match of draft.matchAll(EXTRACT_TIME_RE)) {
    const observation = match[1]!.replace(/\s+/g, " ");
    const clause = clausesAround(draft, match.index ?? 0, match[0].length);
    const obsNorm = normalize(observation);
    for (const property of properties) {
      if (!clauseMentions(clause, property.labels)) continue;
      const allowed = property.extractObservationAt;
      if (allowed != null && normalize(allowed) === obsNorm) continue;
      if (allowed != null) continue; // different clock — separate concern; do not treat as borrow
      const key = `${property.propertyId}::${obsNorm}`;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({
        propertyId: property.propertyId,
        borrowedObservation: observation,
        detail: `Extract observation time "${observation}" is attributed to ${property.propertyId}, but no extract as-of time was supplied for that property.`,
      });
    }
  }
  return issues;
}

/** Source-limits copy must keep unknown extract times explicit. */
export const RENT_SOURCE_DATE_RULE =
  "Never borrow a bank or PMS extract as-of time, retrieval time or observation timestamp from one property onto another. If a property did not supply an extract as-of time, say its extract time is unknown. Transaction dates are not extract observation times.";
