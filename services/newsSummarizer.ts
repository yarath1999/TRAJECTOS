// Lightweight summarizer: extracts short factual summary from provided text.
// This module is deterministic and does not call external APIs.
export function summarizeForFeed(text: unknown): string {
  if (!text) return "";
  let s = typeof text === "string" ? text.trim() : JSON.stringify(text);

  // Reduce long whitespace
  s = s.replace(/\s+/g, " ").trim();

  // Split into sentences, prefer first 2-3 short sentences to make 60-70 words.
  const sentences = s.split(/[\.\!\?]+\s/).map((r) => r.trim()).filter(Boolean);
  if (sentences.length === 0) return s.slice(0, 300);

  const out: string[] = [];
  let wordCount = 0;
  for (const sent of sentences) {
    const words = sent.split(/\s+/).filter(Boolean).length;
    if (wordCount + words > 70 && out.length > 0) break;
    out.push(sent.endsWith('.') ? sent : sent + '.');
    wordCount += words;
    if (wordCount >= 60) break;
  }

  // Join and ensure shortness for mobile
  let summary = out.join(' ');
  if (summary.length > 520) summary = summary.slice(0, 500) + '...';
  return summary;
}

// Simple dedupe helper: normalize title + first 200 chars of text
export function canonicalizeForDedup(title: unknown, text: unknown): string {
  const t = (typeof title === 'string' ? title : String(title ?? '')).toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const b = (typeof text === 'string' ? text : String(text ?? '')).toLowerCase().replace(/[^a-z0-9\s]/g, '');
  const token = (t + ' ' + b.slice(0, 200)).replace(/\s+/g, ' ').trim();
  return token;
}

export function dedupeScore(a: string, b: string): number {
  // simple Jaccard-ish word overlap on token sets
  const sa = new Set(a.split(/\s+/).filter(Boolean));
  const sb = new Set(b.split(/\s+/).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}
