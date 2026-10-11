import { ClauseRisk } from "../types";
import FEATURE_FLAGS from "../config/features";
import { buildTrigramIndex, approximateLocate } from "./trigramIndex";

/**
 * findBestClauseSpan
 * Objectif: retrouver la position (start,end) de la clause dans le texte original de manière robuste
 * sans modifier l'existant ailleurs. Utilise plusieurs stratégies progressives et renvoie la première réussie.
 * Ne lève pas d'exception; retourne null si non trouvé.
 */
export function findBestClauseSpan(
  originalText: string,
  clause: ClauseRisk,
): { start: number; end: number; strategy: string } | null {
  const target = clause.content?.trim();
  if (!target) return null;

  // Optionnel: index trigram paresseux (reconstruit à chaque appel pour simplicité; optimisable)
  const trigramIndex = FEATURE_FLAGS.ENABLE_TRIGRAM_INDEX
    ? buildTrigramIndex(originalText)
    : null;

  // 1. Indices fournis par l'IA (s'ils cadrent et correspondent exactement)
  if (isFiniteNumber(clause.startIndex) && isFiniteNumber(clause.endIndex)) {
    const s = clause.startIndex as number;
    const e = clause.endIndex as number;
    if (
      validBounds(originalText, s, e) &&
      originalText.slice(s, e) === target
    ) {
      return { start: s, end: e, strategy: "ai_exact" };
    }
  }

  // 2. Recherche exacte simple
  const exactPositions = allOccurrences(originalText, target);
  if (exactPositions.length === 1) {
    const s = exactPositions[0];
    return { start: s, end: s + target.length, strategy: "exact_unique" };
  } else if (exactPositions.length > 1) {
    // 3. Désambiguïsation: si indices IA présents, choisir l'occurrence la plus proche de startIndex fourni
    if (isFiniteNumber(clause.startIndex)) {
      const hint = clause.startIndex as number;
      let best = exactPositions[0];
      let bestDelta = Math.abs(best - hint);
      for (const p of exactPositions) {
        const d = Math.abs(p - hint);
        if (d < bestDelta) {
          best = p;
          bestDelta = d;
        }
      }
      return {
        start: best,
        end: best + target.length,
        strategy: "exact_multiple_hint",
      };
    }
    // Sinon: choisir l'occurrence avec le contexte le plus distinctif (ex: entouré de ponctuation ou sauts de ligne)
    let scored = exactPositions.map((p) => ({
      p,
      score: contextScore(originalText, p, target.length),
    }));
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].p;
    return {
      start: best,
      end: best + target.length,
      strategy: "exact_multiple_scored",
    };
  }

  // 4. Normalisation (espaces, retours ligne) puis correspondance
  const normMap = buildNormalizationMap(originalText);
  const normTarget = normalizeText(target);
  const idxNorm = normMap.normalized.indexOf(normTarget);
  if (idxNorm !== -1) {
    // Convertir positions normalisées → indices originaux approximatifs
    const start = mapNormalizedIndexToOriginal(normMap, idxNorm);
    const end =
      mapNormalizedIndexToOriginal(normMap, idxNorm + normTarget.length - 1) +
      1;
    if (validBounds(originalText, start, end)) {
      return { start, end, strategy: "normalized" };
    }
  }

  // 4 bis. Sans aucune espace : le texte analysé sépare les paragraphes alors que le
  // texte du HTML affiché les colle (« …résiliation.Article 5 »), ou l'inverse.
  const compactTarget = target.replace(/\s+/g, "");
  if (compactTarget.length >= 20) {
    const compact = buildCompactMap(originalText);
    const idxCompact = compact.text.indexOf(compactTarget);
    if (idxCompact !== -1) {
      const start = compact.map[idxCompact];
      const end = compact.map[idxCompact + compactTarget.length - 1] + 1;
      if (validBounds(originalText, start, end)) {
        return { start, end, strategy: "compact" };
      }
    }
  }

  // 5. Fallback partiel: essayer un préfixe de la clause (60 premiers chars) s'il est distinctif
  const prefix = target
    .slice(0, Math.min(60, Math.floor(target.length / 2)))
    .trim();
  if (prefix.length >= 20) {
    const prefPositions = allOccurrences(originalText, prefix);
    if (prefPositions.length === 1) {
      const start = prefPositions[0];
      // Heuristique: allonger sur la longueur du texte cible (si possible)
      const end = Math.min(originalText.length, start + target.length);
      return { start, end, strategy: "prefix_heuristic" };
    }
  }

  // 6. Fallback trigram approximatif (si activé) sur la totalité du texte
  if (trigramIndex) {
    const approx = approximateLocate(trigramIndex, target);
    if (approx != null) {
      const end = Math.min(originalText.length, approx + target.length);
      return { start: approx, end, strategy: "trigram_approx" };
    }
  }

  return null; // échec
}

function isFiniteNumber(v: any): v is number {
  return typeof v === "number" && isFinite(v);
}
function validBounds(text: string, s: number, e: number) {
  return s >= 0 && e > s && e <= text.length;
}

function allOccurrences(hay: string, needle: string): number[] {
  const res: number[] = [];
  if (!needle) return res;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    res.push(idx);
    idx = hay.indexOf(needle, idx + 1);
  }
  return res;
}

function contextScore(text: string, pos: number, len: number): number {
  // Score simple: bonus si entouré de retours ligne ou ponctuation
  const before = text[pos - 1] || "\n";
  const after = text[pos + len] || "\n";
  let score = 0;
  if (/\n|\r|\.|;|:/.test(before)) score += 1;
  if (/\n|\r|\.|;|:/.test(after)) score += 1;
  return score;
}

// Normalisation: collapse espaces / retours; garder mapping
interface NormalizationMap {
  normalized: string;
  map: number[];
}
function buildNormalizationMap(original: string): NormalizationMap {
  const map: number[] = [];
  let normalized = "";
  let i = 0;
  while (i < original.length) {
    const ch = original[i];
    if (/\s/.test(ch)) {
      // Regrouper bloc whitespace en un espace unique
      let j = i;
      while (j < original.length && /\s/.test(original[j])) j++;
      normalized += " ";
      map.push(i); // map index du char ajouté vers début du bloc
      i = j;
    } else {
      normalized += ch;
      map.push(i);
      i++;
    }
  }
  return { normalized, map };
}

// Texte sans aucune espace, avec pour chaque caractère sa position dans l'original.
function buildCompactMap(original: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    if (!/\s/.test(original[i])) {
      text += original[i];
      map.push(i);
    }
  }
  return { text, map };
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function mapNormalizedIndexToOriginal(
  nm: NormalizationMap,
  normIdx: number,
): number {
  if (normIdx < 0) return 0;
  if (normIdx >= nm.map.length) return nm.map[nm.map.length - 1] || 0;
  return nm.map[normIdx];
}
