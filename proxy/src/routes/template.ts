import { Router, type Request, type Response } from "express";
import { proxyAuthMiddleware as auth } from "../middleware/authMiddleware.js";
import { BACKEND_URL, BACKNODE_URL } from "../config.js";
import { relayToNode } from "../relay.js";
import { logOpenAiTokens, trackFeature, withTracking } from "../tracking.js";
import { callGpt5, type Gpt5Response } from "../utils/openaiResponses.js";
import { hasQuota, consumeQuota } from "../quota.js";
import {
  buildQuestionsPrompt,
  buildDraftPrompt,
  buildBriefPrompt,
  type PartyIdentity,
  type BriefAttachment,
} from "../services/generateur/scratchPrompts.js";

// Chemin relatif /api/template" 
export const templateRouter: Router = Router();








// ─── Routes ────────────────────────────────────────────────────────────────────
const id = (req: Request) => encodeURIComponent(req.params.externalId as string);

// Import d'un contrat en modèle, en plusieurs étapes (voir « Import d'un contrat → modèle »).
templateRouter.post("/import/warmup", auth, handleImportWarmup);
templateRouter.post("/import/prepare", auth, handleImportPrepare);
templateRouter.post("/import/analyse", auth, handleImportAnalyse);
templateRouter.post("/import/assemble", auth, handleImportAssemble);
templateRouter.post("/import/finalize", auth, handleImportFinalize);

templateRouter.get("/", auth, (req, res) => relayToNode(req, res, "/template"));
templateRouter.get("/:externalId", auth, (req, res) =>
  relayToNode(req, res, `/template/${id(req)}`),
);
templateRouter.put("/:externalId", auth, (req, res) =>
  relayToNode(req, res, `/template/${id(req)}`),
);
templateRouter.delete("/:externalId", auth, (req, res) =>
  relayToNode(req, res, `/template/${id(req)}`),
);
templateRouter.get("/:externalId/playbook", auth, (req, res) =>
  relayToNode(req, res, `/template/${id(req)}/playbook`),
);
templateRouter.put("/:externalId/playbook", auth, (req, res) =>
  relayToNode(req, res, `/template/${id(req)}/playbook`),
);
templateRouter.post("/:externalId/generate", auth, handleTemplateGenerate);

// Génération d'un contrat « de zéro » (générateur). Les prompts sont construits
// ici (services/generateur/scratchPrompts.ts) : le front n'envoie que des données.
templateRouter.post("/generate-questions", auth, handleGenerateQuestions);
templateRouter.post("/generate-draft", auth, handleGenerateDraft);


// Création directe d'un modèle (structure déjà prête, sans structuration IA) —
// utilisée par la génération « de zéro » pour préenregistrer le contrat en
// bibliothèque de modèles.
// Le router est monté sur "/api/template" (voir proxy/index.ts), donc ce chemin
// relatif "/" correspond bien à POST /api/template attendu par le front.
templateRouter.post("/", auth, (req, res) => {
  void trackFeature("import_template", res.locals.userId as number | undefined);
  relayToNode(req, res, "/template");
});







// ─── Génération d'un contrat à partir d'un modèle ──────────────────────────────

const GENERATE_PROMPT_BASE = `Tu es un juriste expert en droit français. À partir du modèle de contrat ci-dessous (dont les variables ont déjà été remplacées par les valeurs fournies par le juriste), produis le contrat final en respectant SCRUPULEUSEMENT ces règles :
- PRIORITÉ ABSOLUE aux CONSIGNES & CLAUSES SPÉCIFIQUES : intègre-les IMPÉRATIVEMENT et INTÉGRALEMENT dans le contrat, même si elles ne figurent pas dans le modèle. Si une consigne fournit le texte d'une clause, insère ce texte fidèlement (en l'adaptant uniquement pour la cohérence rédactionnelle et les accords).
- En cas de CONFLIT entre le modèle et une consigne, la CONSIGNE PRÉVAUT sur le modèle.
- Place chaque clause spécifique à l'endroit juridiquement pertinent du contrat (bon article/section), en renumérotant si besoin.
- Conserve le langage juridique formel et les références légales du texte source.
- Adapte les accords grammaticaux (genre, nombre, conjugaisons) pour un rendu cohérent.
- N'invente AUCUNE clause qui ne soit ni dans le modèle ni dans les consignes.
- Réponds UNIQUEMENT avec le texte final du contrat en français, sans markdown, sans préambule explicatif.`;

/**
 * Substitue les marqueurs <<NAME|original>> et {{NAME}} (legacy)
 * dans le contenu, par les valeurs fournies par l'utilisateur.
 * Si une valeur n'est pas fournie, conserve le texte original (ou le marqueur legacy).
 */
function substituteMarkers(
  content: string,
  variables: Record<string, string>,
): string {
  // Format actuel : <<NAME|original text>>
  let out = content.replace(
    /<<([A-Z0-9_]+)\|([\s\S]*?)>>/g,
    (_match, name: string, original: string) => {
      const val = variables[name];
      return val && val.trim() ? val : original;
    },
  );
  // Compat ancien format : {{NAME}}
  out = out.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => {
    const val = variables[name];
    return val && val.trim() ? val : match;
  });
  return out;
}




async function handleTemplateGenerate(
  req: Request,
  res: Response,
): Promise<void> {
  const externalId = req.params.externalId as string;
  const { variables, playbook } = req.body as {
    variables?: Record<string, string>;
    playbook?: string;
  };

  if (!externalId || !variables || typeof variables !== "object") {
    res
      .status(400)
      .json({ success: false, message: "externalId et variables requis." });
    return;
  }

  try {
    const internalHeaders = {
      "Content-Type": "application/json",
      "x-internal-api-key": process.env.INTERNAL_API_KEY || "",
      ...(res.locals.userId !== undefined
        ? {
          "x-user-id": String(res.locals.userId),
          "x-user-role": String(res.locals.role ?? "USER"),
        }
        : {}),
    };

    // 1. Récupère la structure du modèle
    const tplRes = await fetch(
      `${BACKNODE_URL}/template/${encodeURIComponent(externalId)}`,
      {
        headers: internalHeaders,
      },
    );
    const tplData = (await tplRes.json()) as {
      success: boolean;
      data?: { structure: { sections: any[]; detectedVariables: string[] } };
    };
    if (!tplData.success || !tplData.data) {
      res.status(404).json({ success: false, message: "Modèle introuvable." });
      return;
    }

    // 2. Consignes : on privilégie celles envoyées dans la requête (édition en cours,
    //    prise en compte immédiate). À défaut seulement, on lit le playbook enregistré.
    let playbookText = typeof playbook === "string" ? playbook.trim() : "";
    if (!playbookText) {
      const pbRes = await fetch(
        `${BACKNODE_URL}/template/${encodeURIComponent(externalId)}/playbook`,
        {
          headers: internalHeaders,
        },
      );
      const pbData = (await pbRes.json()) as {
        success: boolean;
        data?: { rulesText: string } | null;
      };
      playbookText = pbData.data?.rulesText?.trim() ?? "";
    }

    // 3. Pré-substitution des marqueurs avec les valeurs utilisateur
    const substitutedSections = tplData.data.structure.sections.map(
      (sec: any) => ({
        title: sec.title,
        clauses: sec.clauses.map((cl: any) => ({
          title: cl.title,
          content: substituteMarkers(cl.content, variables),
        })),
      }),
    );

    // 4. Construit le prompt avec contenu déjà substitué + consignes
    const consignesBlock = playbookText
      ? `\n\nCONSIGNES & CLAUSES SPÉCIFIQUES (PRIORITAIRES — à intégrer impérativement et intégralement) :\n${playbookText}\n`
      : "\n\nCONSIGNES & CLAUSES SPÉCIFIQUES : (aucune règle particulière)\n";
    const docBlock = substitutedSections
      .map(
        (sec: any) =>
          `## ${sec.title}\n\n` +
          sec.clauses
            .map((cl: any) =>
              cl.title ? `### ${cl.title}\n${cl.content}` : cl.content,
            )
            .join("\n\n"),
      )
      .join("\n\n");
    const prompt = `${GENERATE_PROMPT_BASE}${consignesBlock}\nCONTRAT (à finaliser) :\n${docBlock}\n\nProduis maintenant le contrat final :`;

    console.timeLog("appel gpt ")
    // 5. Appel gpt-5.2
    const aiRes = await fetch(`${BACKEND_URL}/openai-chat-5`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        reasoning: "medium",
        verbosity: "medium",
        model: "gpt-5.2",
      }),
    });
    console.timeLog("appel gpt")
    if (!aiRes.ok) {
      res
        .status(502)
        .json({ success: false, message: "Génération AI échouée." });
      return;
    }
    const aiData = (await aiRes.json()) as {
      content?: string;
      openai_tokens?: unknown;
    };

    // Log tokens
    if (aiData.openai_tokens && res.locals.userId) {
      await logOpenAiTokens(
        { openai_tokens: aiData.openai_tokens } as any,
        res.locals.userId as number,
      );
    }

    void trackFeature(
      "generate_contract",
      res.locals.userId as number | undefined,
    );
    res.json({
      success: true,
      content: aiData.content ?? "",
      templateName: (tplData.data as any).meta?.name ?? null,
    });
  } catch (e: any) {
    console.error("[template/generate] error:", e.message);
    if (!res.headersSent)
      res.status(500).json({
        success: false,
        message: "Erreur interne lors de la génération.",
      });
  }
}



// ─── Import d'un contrat → modèle ──────────────────────────────────────────────
//
// L'import se fait en plusieurs requêtes, pour que le front affiche le contrat
// tout de suite puis ses champs au fur et à mesure :
// 1. « prepare » : le texte extrait est découpé en paragraphes numérotés. Les
//    emplacements vides d'un modèle vierge ("....", "…", "____", "[à compléter]")
//    sont repérés par le code et remplacés par des repères numérotés [[P1]],
//    [[P2]]… Le document est coupé en quelques parties.
// 2. « analyse » : une requête par partie, lancées en même temps par le front.
//    L'IA lit tout le contrat (pour nommer les champs de façon cohérente) mais
//    ne répond que pour sa partie. Elle ne réécrit PAS le contrat : elle renvoie
//    seulement, une information par ligne,
//    - les numéros des paragraphes qui sont des titres (pour découper en sections),
//    - un nom pour chaque repère [[Pn]] (modèle vierge),
//    - les variables avec leurs valeurs exactes (contrat déjà rempli).
// 3. « assemble » (aperçu, à chaque partie terminée) puis « finalize »
//    (enregistrement) : le code découpe les sections et place lui-même les
//    marqueurs <<NOM_VARIABLE|texte original>> dans le texte.
// Avantages : c'est l'écriture de sa réponse qui prend le temps de l'IA ; une
// réponse compacte, partagée entre plusieurs appels simultanés, arrive vite. Et
// le texte du contrat est garanti identique à l'original.

/** Taille max du texte envoyé à l'IA. Le découpage et les marqueurs s'appliquent
 *  quand même à tout le document. */
const MAX_CHARS_SENT_TO_AI = 150_000;

/** Taille max du document que le front renvoie aux étapes suivantes. */
const MAX_DOCUMENT_CHARS = 2_000_000;

/** Nombre max de parties analysées en même temps (le moteur Python accepte 5 appels IA simultanés). */
const MAX_ANALYSIS_PARTS = 4;

/** Volume de travail visé par partie : un document court reste en une seule partie. */
const TARGET_PART_WEIGHT = 3_000;

/** Poids d'un repère [[Pn]] dans le découpage : chaque repère ajoute une ligne à la réponse de l'IA. */
const PLACEHOLDER_WEIGHT = 400;

/**
 * Nom du marqueur provisoire d'un emplacement vide pas encore nommé par l'IA :
 * affiché « en cours » par le front pendant l'analyse, jamais enregistré.
 * Même valeur dans front/src/components/DashboardComponents/Generateur.tsx.
 */
const PENDING_VARIABLE_NAME = "__IMPORT_EN_COURS__";

const EXTRACT_VARIABLES_PROMPT_BASE = `Tu reçois le texte d'un contrat. Chaque paragraphe est précédé de son numéro, au format "12| texte du paragraphe".
Ta mission : repérer les informations propres à CE contrat, qu'un juriste devra compléter ou modifier pour réutiliser le document comme modèle, et repérer les paragraphes qui sont des titres.
Tu ne dois PAS réécrire le contrat.

Le document peut être :
- un modèle VIERGE : les emplacements à compléter ("....", "…", "____", "[à compléter]") ont été remplacés par des repères [[P1]], [[P2]]… Quand une indication suivait l'emplacement, elle est ajoutée dans le repère : [[P1 (forme juridique)]] ;
- un contrat DÉJÀ REMPLI : les informations sont écrites en toutes lettres ;
- un mélange des deux.

FORMAT DE RÉPONSE : uniquement des lignes comme celles-ci, une information par ligne, champs séparés par "|", sans markdown ni phrase :
TYPE|Type de contrat en quelques mots
TITRES|3,8,15
P1|DENOMINATION_APPORTEUR|Dénomination de l'apporteur|text
VAL|DENOMINATION_PRESTATAIRE|Dénomination du prestataire|text|Alpha Conseil SAS|ALPHA CONSEIL
- TYPE : une seule ligne.
- TITRES : une seule ligne, numéros de paragraphes séparés par des virgules.
- Une ligne par repère [[Pn]] à compléter (modèle vierge) : identifiant du repère, nom, libellé, type.
- Une ligne VAL par information écrite en toutes lettres (contrat rempli) : nom, libellé, type, puis chaque forme de la valeur trouvée dans le texte.
- N'écris jamais le caractère "|" dans un nom, un libellé ou une valeur.

OÙ CHERCHER :
- La désignation des parties ("Entre les soussignés", "ENTRE :", "ET :") et le préambule contiennent la plupart des variables : analyse-les EN ENTIER et en priorité, pour CHAQUE partie.
- Puis le reste du contrat : dates, durées, montants, lieux, désignations spécifiques, bloc de signature.

INFORMATIONS À REPÉRER :
- identité des parties : dénomination, forme sociale, capital social, adresse du siège, numéro de TVA intracommunautaire, SIREN / SIRET / RCS, ville d'immatriculation, représentant et sa qualité ;
- dates, durées, délais, montants, pourcentages, taux ;
- éléments spécifiques à l'opération : désignation du bien, de la prestation, du poste, du territoire, lieu d'exécution ;
- lieu et date de signature.

À NE PAS REPÉRER :
- le texte juridique générique et les références légales (ex : "article 1103 du Code civil") ;
- les numéros d'articles, les titres, les numéros de page ;
- les appellations génériques des parties ("le Prestataire", "la Société", "les Parties") ;
- les dates de textes officiels : lois, ordonnances, décrets, arrêtés, conventions et accords collectifs ("la loi du 30 août 1947", "l'ordonnance du 7 janvier 1959", "la convention collective du 3 octobre 1975") ;
- les mots isolés du texte courant (articles, pronoms, adjectifs comme "Le", "exclusif") : une valeur est une information complète, jamais un mot de la phrase.

RÈGLES POUR LES REPÈRES [[Pn]] (modèle vierge) :
- Donne une ligne pour CHAQUE repère [[Pn]] qui correspond à une information à compléter. Déduis le nom du texte qui entoure le repère : "dont le siège social est situé [[P2]]" → ADRESSE_SIEGE_APPORTEUR.
- Ignore un repère qui n'est pas une information à compléter (ex : points de suspension à la fin d'une énumération, points de conduite d'un sommaire).
- Deux repères qui concernent des parties différentes ont des noms différents (ADRESSE_SIEGE_APPORTEUR et ADRESSE_SIEGE_SOCIETE).
- Deux repères qui demandent exactement la même information pour la même partie ont le même nom.

RÈGLES POUR LES LIGNES VAL (contrat rempli) :
- Recopie chaque valeur EXACTEMENT comme dans le texte (majuscules, accents, ponctuation), sans le numéro de paragraphe.
- La valeur ne contient que l'information elle-même : "15 000 euros" et non "pour un montant de 15 000 euros".
- Si la même information apparaît sous plusieurs formes ("Alpha Conseil SAS", "ALPHA CONSEIL"), mets toutes les formes sur la même ligne.
- Une même valeur ne doit apparaître que sur UNE seule ligne.
- Ne mets jamais un repère [[Pn]] dans une valeur.

RÈGLES POUR LE NOM, LE LIBELLÉ ET LE TYPE :
- nom : MAJUSCULES_AVEC_UNDERSCORES, sans accent, qui décrit l'information puis, si besoin, la partie concernée, toujours dans cet ordre (DENOMINATION_CLIENT et non CLIENT_DENOMINATION, ADRESSE_SIEGE_CLIENT, DATE_EFFET). Pas de suffixe _1, _2 ajouté pour distinguer deux champs. Pour la partie, reprends toujours son rôle tel que la désignation des parties le définit (ASSOCIE_1, SOCIETE, CLIENT, PRESTATAIRE…) : une même information porte ainsi le même nom partout dans le contrat, de l'en-tête aux annexes.
- libellé : libellé court en français correct, lisible par un juriste, avec ses accents et ses apostrophes (ex : "Délai de convocation du comité", "Adresse de l'adhérent").
- type : "text", "date", "number", "money" ou "duration".

RÈGLES POUR TITRES :
- Numéros des paragraphes qui sont des titres de parties, d'articles ou de sous-articles (ex : "PRÉAMBULE", "ARTICLE 1 – OBJET", "7.2 Notification", "ANNEXE 1 – RÉPARTITION DU CAPITAL"), dans l'ordre du texte.
- N'inclus pas le titre principal du document.`;

type VariableType = "text" | "date" | "number" | "money" | "duration";

const ALLOWED_VARIABLE_TYPES: VariableType[] = ["text", "date", "number", "money", "duration"];

interface VariableDefinition {
  name: string;
  label: string;
  type: VariableType;
}

/** Variable d'un contrat rempli : l'IA donne les valeurs à retrouver dans le texte. */
interface ExtractedVariable extends VariableDefinition {
  values: string[];
}

/** Repère [[Pn]] d'un modèle vierge, nommé par l'IA. */
interface NamedPlaceholder extends VariableDefinition {
  id: string;
}

interface AiExtractionResult {
  contractType: string | null;
  headingLines: number[];
  placeholders: NamedPlaceholder[];
  variables: ExtractedVariable[];
}

const EMPTY_EXTRACTION: AiExtractionResult = { contractType: null, headingLines: [], placeholders: [], variables: [] };

/** Emplacement vide repéré par le code dans un modèle vierge. */
interface BlankPlaceholder {
  /** Texte exact du document (ex : ". .. ; (forme juridique)"). */
  originalText: string;
  /** Indication entre parenthèses qui suivait l'emplacement (ex : "forme juridique"). */
  hint: string | null;
}

/** Document préparé. Il fait l'aller-retour avec le front entre les étapes de l'import. */
interface PreparedDocument {
  /** Paragraphes où chaque emplacement vide est remplacé par [[P1]], [[P2]]… */
  paragraphs: string[];
  /** Emplacement d'origine de chaque repère : "P1" → { originalText, hint }. */
  placeholders: Record<string, BlankPlaceholder>;
}

/** Paragraphes analysés par un même appel à l'IA (numéros à partir de 1, bornes incluses). */
interface AnalysisPart {
  first: number;
  last: number;
}

interface TemplateSection {
  title: string;
  clauses: Array<{ id: string; title: string; content: string; variables: string[] }>;
}

/** Erreur d'import, avec le code HTTP et le message à renvoyer au front. */
class ImportError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Emplacements vides d'un modèle vierge :
 * - [à compléter], [NOM], […]
 * - ____ (au moins 3 tirets bas)
 * - "…", "...", ". .." (au moins 3 points, espaces isolés tolérés)
 * - XXX
 * éventuellement suivis d'une indication entre parenthèses : ". .. ; (forme juridique)".
 * Groupes : 1 = emplacement, 2 = partie parenthèse complète, 3 = texte de l'indication.
 */
const BLANK_REGEX = /(\[[^\[\]]{0,40}\]|_{3,}|…(?:[ \t]?[.…])*|\.(?:[ \t]?[.…]){2,}|\bX{3,}\b)([ \t]*[;,]?[ \t]*\(([^()]{1,40})\))?/g;

/** Repère inséré dans le texte à la place d'un emplacement vide : [[P1]]. */
const PLACEHOLDER_TOKEN_REGEX = /\[\[(P\d+)\]\]/g;

/**
 * Découpe le texte extrait en paragraphes non vides.
 * Le moteur Python sépare ses paragraphes par une ligne vide (lignes déjà
 * recollées, mots coupés réparés, en-têtes et pieds de page retirés) : on les
 * garde tels quels.
 * Texte sans ligne vide (ancien format) : les PDF coupent souvent une phrase
 * sur plusieurs lignes ; si une ligne se termine par une virgule ou si la
 * suivante commence par une minuscule, c'est le même paragraphe.
 */
function splitIntoParagraphs(text: string): string[] {
  if (/\n[ \t]*\n/.test(text)) {
    return text
      .split(/\n[ \t]*\n/)
      .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
      .filter((paragraph) => paragraph.length > 0);
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  const paragraphs: string[] = [];
  for (const line of lines) {
    const previous = paragraphs[paragraphs.length - 1];
    const previousEndsWithComma = previous !== undefined && /[,(–-]$/.test(previous);
    const lineStartsWithLowercase = /^[a-zàâäçéèêëîïôöûùüÿœ]/.test(line);

    if (previous !== undefined && (previousEndsWithComma || lineStartsWithLowercase)) {
      paragraphs[paragraphs.length - 1] = previous + " " + line;
    } else {
      paragraphs.push(line);
    }
  }
  return paragraphs;
}

/** Découpe le texte en paragraphes et remplace les emplacements vides par des repères [[Pn]]. */
function prepareDocument(text: string): PreparedDocument {
  const placeholders: Record<string, BlankPlaceholder> = {};
  let placeholderCount = 0;

  const paragraphs = splitIntoParagraphs(text).map((paragraph) =>
    paragraph.replace(
      BLANK_REGEX,
      (fullMatch: string, blank: string, parenthesisPart: string | undefined, hintText: string | undefined) => {
        placeholderCount += 1;
        const id = `P${placeholderCount}`;

        // Une parenthèse de définition ("(ci-après « la Société »)") n'est pas une
        // indication de saisie : elle reste dans le texte, hors du repère.
        const isDefinition = hintText !== undefined && /«|ci-apr/i.test(hintText);

        if (parenthesisPart === undefined || hintText === undefined || isDefinition) {
          placeholders[id] = { originalText: blank, hint: null };
          return `[[${id}]]${parenthesisPart ?? ""}`;
        }

        placeholders[id] = { originalText: fullMatch, hint: hintText.trim() };
        return `[[${id}]]`;
      },
    ),
  );

  return { paragraphs, placeholders };
}

/**
 * Construit le texte envoyé à l'IA : "1| paragraphe", "2| paragraphe"…
 * paragraphCount : nombre de paragraphes qui tiennent dans la limite envoyée à l'IA.
 */
function buildNumberedText(document: PreparedDocument): { numberedText: string; paragraphCount: number; isTruncated: boolean } {
  let numberedText = "";
  for (let index = 0; index < document.paragraphs.length; index++) {
    // Pour l'IA, l'indication est ajoutée dans le repère : [[P1 (forme juridique)]].
    const paragraphForAi = document.paragraphs[index].replace(PLACEHOLDER_TOKEN_REGEX, (token: string, id: string) => {
      const hint = document.placeholders[id]?.hint;
      return hint ? `[[${id} (${hint})]]` : token;
    });

    const numberedLine = `${index + 1}| ${paragraphForAi}\n`;
    if (numberedText.length + numberedLine.length > MAX_CHARS_SENT_TO_AI) {
      return { numberedText, paragraphCount: index, isTruncated: true };
    }
    numberedText += numberedLine;
  }
  return { numberedText, paragraphCount: document.paragraphs.length, isTruncated: false };
}

/**
 * Découpe les paragraphes à analyser en parties de volume de travail proche.
 * Le volume compte le texte et surtout les repères [[Pn]] : chacun allonge la
 * réponse de l'IA, qui est ce qui prend le plus de temps.
 */
function splitIntoParts(paragraphs: string[]): AnalysisPart[] {
  const weights = paragraphs.map(
    (paragraph) => paragraph.length + PLACEHOLDER_WEIGHT * (paragraph.match(PLACEHOLDER_TOKEN_REGEX)?.length ?? 0),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const partCount = Math.min(MAX_ANALYSIS_PARTS, paragraphs.length, Math.max(1, Math.round(totalWeight / TARGET_PART_WEIGHT)));

  const parts: AnalysisPart[] = [];
  let first = 1;
  let accumulatedWeight = 0;
  weights.forEach((weight, index) => {
    accumulatedWeight += weight;
    const isLastParagraph = index === weights.length - 1;
    const reachesNextBoundary = accumulatedWeight >= (totalWeight * (parts.length + 1)) / partCount;
    if (isLastParagraph || (reachesNextBoundary && parts.length < partCount - 1)) {
      parts.push({ first, last: index + 1 });
      first = index + 2;
    }
  });
  return parts;
}

/** Identifiants des repères [[Pn]] présents dans les paragraphes des parties données. */
function placeholderIdsIn(document: PreparedDocument, parts: AnalysisPart[]): Set<string> {
  const ids = new Set<string>();
  for (const part of parts) {
    for (const paragraph of document.paragraphs.slice(part.first - 1, part.last)) {
      for (const match of paragraph.matchAll(PLACEHOLDER_TOKEN_REGEX)) ids.add(match[1]);
    }
  }
  return ids;
}

/** Consignes de périmètre quand le document est analysé en plusieurs parties. */
function buildPartInstructions(part: AnalysisPart, analysedParagraphCount: number): { scope: string; reminder: string } {
  if (part.first === 1 && part.last >= analysedParagraphCount) return { scope: "", reminder: "" };

  const range = `${part.first} à ${part.last}`;
  return {
    scope: `

PÉRIMÈTRE : le contrat est analysé en plusieurs morceaux, en même temps. Tu traites UNIQUEMENT les paragraphes ${range} (inclus). Le reste du texte sert seulement à comprendre le contexte : qui sont les parties, et quels noms leur donner.
- TYPE : toujours, pour le contrat entier.
- TITRES : seulement les numéros de ${range}.
- Repères [[Pn]] : seulement ceux présents dans les paragraphes ${range}.
- Lignes VAL : seulement les informations présentes dans les paragraphes ${range}.`,
    reminder: `\n\nRAPPEL : réponds uniquement pour les paragraphes ${range}.`,
  };
}

/** Transforme "Nom de la société" ou "nom_société" en "NOM_DE_LA_SOCIETE". */
function toVariableName(rawName: string): string {
  return rawName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Lit nom, libellé et type d'une variable (null si le nom est vide). */
function readVariableDefinition(rawName: unknown, rawLabel: unknown, rawType: unknown): VariableDefinition | null {
  const name = toVariableName(String(rawName ?? ""));
  if (!name) return null;
  const typeText = String(rawType ?? "").trim().toLowerCase();
  const type = ALLOWED_VARIABLE_TYPES.find((allowedType) => allowedType === typeText) ?? "text";
  const label = String(rawLabel ?? "").trim() || name;
  return { name, label, type };
}

/**
 * Garde les valeurs exploitables. On écarte les valeurs trop courtes, sans lettre
 * ni chiffre, ou contenant les caractères des marqueurs / repères (elles
 * casseraient le texte).
 */
function cleanValues(rawValues: unknown[]): string[] {
  return rawValues
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 2 && /[\p{L}\p{N}]/u.test(value) && !/<<|>>|\||\[\[|\]\]/.test(value))
    .filter((value) => !MOTS_COURANTS.has(value.toLowerCase()));
}

/** Mots du texte courant que l'IA prend parfois pour une valeur ("Le", "exclusif"). */
const MOTS_COURANTS = new Set([
  "le", "la", "les", "l'", "un", "une", "des", "du", "de", "il", "elle", "ils", "elles", "et", "ou",
  "exclusif", "exclusive", "non exclusif", "non exclusive", "monsieur", "madame",
]);

/** Date d'un texte officiel juste avant la valeur ("loi du", "ordonnance du"…) : pas une variable. */
const REFERENCE_OFFICIELLE = /(lois?|ordonnances?|d[ée]crets?|arr[êe]t[ée]s?|conventions?\s+collectives?|accords?(\s+collectifs?|\s+nationa(l|ux))?|circulaires?|directives?|r[èe]glements?)[^.;:]{0,40}?(du|des|en\s+date\s+du)\s*$/iu;

/**
 * Lit la réponse de l'IA (une information par ligne, champs séparés par "|") et
 * ne garde que les données exploitables. Aucune ligne reconnue : réponse inutilisable.
 */
function parseAiExtraction(rawContent: string): AiExtractionResult {
  const extraction: AiExtractionResult = { contractType: null, headingLines: [], placeholders: [], variables: [] };
  const variablesByName = new Map<string, ExtractedVariable>();
  let recognizedLineCount = 0;

  for (const line of rawContent.split(/\r?\n/)) {
    const fields = line.split("|").map((field) => field.trim());
    const kind = (fields[0] ?? "").replace(/^[-*•\s]+/, "").toUpperCase();

    if (kind === "TYPE" && fields[1]) {
      extraction.contractType ??= fields[1];
    } else if (kind === "TITRES") {
      extraction.headingLines.push(
        ...(fields[1] ?? "").split(/[^0-9]+/).map(Number).filter((lineNumber) => lineNumber > 0),
      );
    } else if (/^P\d+$/.test(kind)) {
      const definition = readVariableDefinition(fields[1], fields[2], fields[3]);
      if (!definition) continue;
      extraction.placeholders.push({ id: kind, ...definition });
    } else if (kind === "VAL") {
      const definition = readVariableDefinition(fields[1], fields[2], fields[3]);
      const values = cleanValues(fields.slice(4));
      if (!definition || values.length === 0) continue;

      // Si l'IA donne deux fois le même nom, on fusionne les valeurs.
      const existing = variablesByName.get(definition.name);
      if (existing) {
        existing.values.push(...values);
      } else {
        variablesByName.set(definition.name, { ...definition, values });
      }
    } else {
      continue;
    }
    recognizedLineCount += 1;
  }

  if (recognizedLineCount === 0) throw new ImportError(422, "La réponse de l'IA est illisible.");
  extraction.variables = Array.from(variablesByName.values());
  return extraction;
}

/** Ne garde que ce qui revient à la partie analysée : les titres et les repères de ses paragraphes. */
function keepPartOnly(extraction: AiExtractionResult, document: PreparedDocument, part: AnalysisPart): AiExtractionResult {
  const partPlaceholderIds = placeholderIdsIn(document, [part]);
  return {
    ...extraction,
    headingLines: extraction.headingLines.filter((lineNumber) => lineNumber >= part.first && lineNumber <= part.last),
    placeholders: extraction.placeholders.filter((placeholder) => partPlaceholderIds.has(placeholder.id)),
    // Les valeurs d'un contrat rempli sont gardées : elles sont recherchées dans tout le texte.
  };
}

/** Forme comparable d'une valeur : casse, espaces et apostrophes ne comptent pas. */
function normalizeValue(value: string): string {
  return value.toLowerCase().replace(/['’‘`]/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * Réunit les analyses des parties, dans l'ordre du document, sans qu'une même
 * information apparaisse sous deux noms : le premier nom rencontré est gardé
 * - pour les mêmes mots dans un autre ordre (DENOMINATION_SOCIETE / SOCIETE_DENOMINATION),
 * - pour une valeur déjà rattachée à une variable par une partie précédente.
 */
function mergeExtractions(extractions: AiExtractionResult[]): AiExtractionResult {
  const merged: AiExtractionResult = { contractType: null, headingLines: [], placeholders: [], variables: [] };
  const placeholderIds = new Set<string>();
  const variablesByName = new Map<string, ExtractedVariable>();
  const variableNameByValue = new Map<string, string>();

  const nameByWordSet = new Map<string, string>();
  const harmonizeName = (name: string): string => {
    const wordSet = name.split("_").sort().join("_");
    const knownName = nameByWordSet.get(wordSet);
    if (knownName) return knownName;
    nameByWordSet.set(wordSet, name);
    return name;
  };

  for (const extraction of extractions) {
    merged.contractType ??= extraction.contractType;
    merged.headingLines.push(...extraction.headingLines);

    for (const placeholder of extraction.placeholders) {
      if (placeholderIds.has(placeholder.id)) continue;
      placeholderIds.add(placeholder.id);
      merged.placeholders.push({ ...placeholder, name: harmonizeName(placeholder.name) });
    }

    for (const variable of extraction.variables) {
      const knownName = variable.values
        .map((value) => variableNameByValue.get(normalizeValue(value)))
        .find((name) => name !== undefined);
      const name = knownName ?? harmonizeName(variable.name);

      const existing = variablesByName.get(name);
      if (existing) {
        existing.values.push(...variable.values);
      } else {
        variablesByName.set(name, { ...variable, values: [...variable.values] });
      }
      for (const value of variable.values) {
        if (!variableNameByValue.has(normalizeValue(value))) variableNameByValue.set(normalizeValue(value), name);
      }
    }
  }

  merged.variables = Array.from(variablesByName.values());
  return merged;
}

/**
 * Découpe les paragraphes en sections à partir des numéros de titres donnés par l'IA.
 * Ce qui précède le premier titre devient la section "En-tête".
 */
/** Au-delà, un paragraphe marqué « titre » par l'IA contient aussi du texte courant. */
const MAX_HEADING_LENGTH = 120;

function buildSections(paragraphs: string[], headingLines: number[]): Array<{ title: string; paragraphs: string[] }> {
  // Numéros IA (commencent à 1) → index du tableau, sans doublon.
  const headingIndexes = new Set(
    headingLines
      .map((line) => line - 1)
      .filter((index) => index >= 0 && index < paragraphs.length),
  );

  const sections: Array<{ title: string; paragraphs: string[] }> = [];
  let currentSection = { title: "En-tête", paragraphs: [] as string[] };
  let currentSectionIsHeader = true;

  paragraphs.forEach((rawParagraph, index) => {
    let paragraph = rawParagraph;
    let isHeading = headingIndexes.has(index);
    let bodyAfterHeading: string | null = null;
    // « Article 1 : Les époux choisissent… » : titre et texte sur la même ligne.
    // Seul le début devient titre ; sinon tout le texte s'afficherait en style de titre.
    if (isHeading && paragraph.length > MAX_HEADING_LENGTH) {
      const split = paragraph.match(/^(.{1,80}?)\s*[:–—-]\s+([\s\S]+)$/);
      if (split) {
        paragraph = split[1];
        bodyAfterHeading = split[2];
      } else {
        isHeading = false;
      }
    }
    const currentTitleHasNoContent = !currentSectionIsHeader && currentSection.paragraphs.length === 0;

    if (isHeading && currentTitleHasNoContent) {
      // Deux titres qui se suivent ("TITRE I" puis "ARTICLE 1") : on les regroupe
      // pour ne perdre aucun texte.
      currentSection.title = `${currentSection.title} — ${paragraph}`;
    } else if (isHeading) {
      currentSectionIsHeader = false;
      if (currentSection.paragraphs.length > 0) sections.push(currentSection);
      currentSection = { title: paragraph, paragraphs: [] };
    } else {
      currentSection.paragraphs.push(paragraph);
    }
    if (bodyAfterHeading) currentSection.paragraphs.push(bodyAfterHeading);
  });
  if (currentSection.paragraphs.length > 0) sections.push(currentSection);

  return sections;
}

/** Échappe les caractères spéciaux d'une chaîne pour l'utiliser dans une RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Transforme une valeur en motif de recherche tolérant : les espaces, apostrophes
 * et tirets peuvent différer entre le texte extrait et ce que l'IA recopie
 * (ex : ' et ’).
 */
function valueToSearchPattern(value: string): string {
  let pattern = "";
  for (const char of value) {
    if (char === " ") pattern += "\\s+";
    else if ("'’‘`".includes(char)) pattern += "['’‘`]";
    else if ("-–—‑".includes(char)) pattern += "[-–—‑]";
    else pattern += escapeRegExp(char);
  }
  return pattern;
}

/**
 * Entoure chaque valeur trouvée dans le contenu d'un marqueur <<NOM|valeur>>.
 * Une seule expression régulière est utilisée pour toutes les valeurs, les plus
 * longues en premier : une valeur déjà marquée ne peut donc pas être re-marquée
 * (ex : "Paris" à l'intérieur de "10 rue des Lilas, 75010 Paris").
 */
function insertVariableMarkers(content: string, variables: ExtractedVariable[]): string {
  const valuesToFind = variables
    .flatMap((variable) => variable.values.map((value) => ({ value, name: variable.name })))
    .sort((a, b) => b.value.length - a.value.length);
  if (valuesToFind.length === 0) return content;

  // Chaque valeur a son propre groupe capturant, pour retrouver la variable correspondante.
  const alternatives = valuesToFind.map((item) => `(${valueToSearchPattern(item.value)})`).join("|");
  // Les lookarounds évitent de marquer une valeur au milieu d'un mot ("Paris" dans "Parisien").
  const searchRegex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "gu");

  return content.replace(searchRegex, (matchedText, ...groups) => {
    const offset = groups[groups.length - 2] as number;
    if (typeof offset === "number" && REFERENCE_OFFICIELLE.test(content.slice(Math.max(0, offset - 80), offset))) return matchedText;
    const matchedIndex = groups.findIndex((group, index) => index < valuesToFind.length && group !== undefined);
    const variableName = valuesToFind[matchedIndex]?.name;
    return variableName ? `<<${variableName}|${matchedText}>>` : matchedText;
  });
}

/**
 * Remet le texte d'origine à la place des repères [[Pn]] :
 * - repère nommé par l'IA → marqueur <<NOM|texte d'origine>>
 * - repère d'une partie pas encore analysée → marqueur provisoire « en cours »
 * - repère ignoré par l'IA → texte d'origine tel quel
 */
function replacePlaceholderTokens(
  content: string,
  document: PreparedDocument,
  placeholderNames: Map<string, string>,
  pendingPlaceholderIds: Set<string> = new Set(),
): string {
  return content.replace(PLACEHOLDER_TOKEN_REGEX, (token: string, id: string) => {
    const placeholder = document.placeholders[id];
    if (!placeholder) return token;
    if (pendingPlaceholderIds.has(id)) return `<<${PENDING_VARIABLE_NAME}|${placeholder.originalText}>>`;
    const variableName = placeholderNames.get(id);
    return variableName ? `<<${variableName}|${placeholder.originalText}>>` : placeholder.originalText;
  });
}

/** Liste les noms de variables présents dans un contenu, dans l'ordre d'apparition. */
function listVariablesInContent(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(/<<([A-Z0-9_]+)\|/g)) {
    if (match[1] && match[1] !== PENDING_VARIABLE_NAME) names.add(match[1]);
  }
  return Array.from(names);
}

/**
 * Assemble la structure du modèle (même format que celui attendu par le front et backNode).
 * pendingPlaceholderIds : repères des parties pas encore analysées, affichés « en cours ».
 */
function buildTemplateStructure(
  document: PreparedDocument,
  extraction: AiExtractionResult,
  pendingPlaceholderIds: Set<string> = new Set(),
) {
  const placeholderNames = new Map(extraction.placeholders.map((placeholder) => [placeholder.id, placeholder.name]));

  const sections: TemplateSection[] = buildSections(document.paragraphs, extraction.headingLines).map(
    (section, index) => {
      const contentWithValueMarkers = insertVariableMarkers(section.paragraphs.join("\n"), extraction.variables);
      const content = replacePlaceholderTokens(contentWithValueMarkers, document, placeholderNames, pendingPlaceholderIds);
      // Les titres ne reçoivent pas de marqueur : on y remet seulement le texte d'origine.
      const title = replacePlaceholderTokens(section.title, document, new Map());
      return {
        title,
        clauses: [{ id: `s${index + 1}_c1`, title: "", content, variables: listVariablesInContent(content) }],
      };
    },
  );

  // Libellé et type de chaque variable, qu'elle vienne d'une valeur ou d'un repère.
  const definitionsByName = new Map<string, VariableDefinition>();
  for (const { name, label, type } of [...extraction.variables, ...extraction.placeholders]) {
    if (!definitionsByName.has(name)) definitionsByName.set(name, { name, label, type });
  }

  // On ne garde que les variables réellement placées dans le texte.
  const placedNames = Array.from(
    new Set(sections.flatMap((section) => section.clauses.flatMap((clause) => clause.variables))),
  );

  return {
    sections,
    detectedVariables: placedNames,
    variableDefs: placedNames.map(
      (name) => definitionsByName.get(name) ?? { name, label: name, type: "text" as VariableType },
    ),
  };
}

// ─── Lecture des données renvoyées par le front ────────────────────────────────

/** Relit le document préparé renvoyé par le front (null s'il est invalide ou trop grand). */
function readPreparedDocument(raw: any): PreparedDocument | null {
  const paragraphs: unknown = raw?.paragraphs;
  if (!Array.isArray(paragraphs) || !paragraphs.every((paragraph) => typeof paragraph === "string")) return null;
  const totalChars = paragraphs.reduce((sum: number, paragraph: string) => sum + paragraph.length, 0);
  if (totalChars > MAX_DOCUMENT_CHARS) return null;

  const placeholders: Record<string, BlankPlaceholder> = {};
  for (const [id, placeholder] of Object.entries((raw?.placeholders ?? {}) as Record<string, any>)) {
    if (!/^P\d+$/.test(id) || typeof placeholder?.originalText !== "string") continue;
    placeholders[id] = {
      originalText: placeholder.originalText,
      hint: typeof placeholder.hint === "string" ? placeholder.hint : null,
    };
  }
  return { paragraphs, placeholders };
}

/** Relit une partie (null si ses bornes ne correspondent pas au document). */
function readPart(raw: any, document: PreparedDocument): AnalysisPart | null {
  const first = Number(raw?.first);
  const last = Number(raw?.last);
  const isValid = Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first && last <= document.paragraphs.length;
  return isValid ? { first, last } : null;
}

/** Relit une analyse de partie renvoyée par le front, en la revalidant comme une réponse de l'IA. */
function readExtraction(raw: any): AiExtractionResult | null {
  if (!raw || typeof raw !== "object") return null;

  const placeholders: NamedPlaceholder[] = [];
  for (const rawPlaceholder of Array.isArray(raw.placeholders) ? raw.placeholders : []) {
    const id = String(rawPlaceholder?.id ?? "");
    const definition = readVariableDefinition(rawPlaceholder?.name, rawPlaceholder?.label, rawPlaceholder?.type);
    if (/^P\d+$/.test(id) && definition) placeholders.push({ id, ...definition });
  }

  const variables: ExtractedVariable[] = [];
  for (const rawVariable of Array.isArray(raw.variables) ? raw.variables : []) {
    const definition = readVariableDefinition(rawVariable?.name, rawVariable?.label, rawVariable?.type);
    const values = cleanValues(Array.isArray(rawVariable?.values) ? rawVariable.values : []);
    if (definition && values.length > 0) variables.push({ ...definition, values });
  }

  return {
    contractType: typeof raw.contractType === "string" && raw.contractType.trim() ? raw.contractType.trim() : null,
    headingLines: Array.isArray(raw.headingLines)
      ? raw.headingLines.filter((lineNumber: unknown): lineNumber is number => Number.isInteger(lineNumber))
      : [],
    placeholders,
    variables,
  };
}

/** Relit les analyses des parties, dans l'ordre du document (les parties sans résultat sont ignorées). */
function readExtractions(raw: unknown): AiExtractionResult[] {
  return (Array.isArray(raw) ? raw : [])
    .map(readExtraction)
    .filter((extraction): extraction is AiExtractionResult => extraction !== null);
}

// ─── Étapes de l'import ────────────────────────────────────────────────────────

/** Extrait le texte du fichier via le moteur Python. */
async function extractDocumentText(fileBase64: string, filename: string): Promise<string> {
  // Le fichier part en JSON (base64) et non en multipart : chez o2switch, un envoi
  // multipart contenant un fichier est détourné avant d'atteindre le moteur Python (404).
  const extractRes = await fetch(`${BACKEND_URL}/extract-document-text-json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, fileBase64 }),
  });
  if (extractRes.status === 422) {
    // Refus expliqué par le moteur (ancien .doc, PDF protégé, document vide) : message montré tel quel.
    const refus = (await extractRes.json().catch(() => ({}))) as { detail?: string };
    throw new ImportError(422, refus.detail || "Document illisible.");
  }
  if (!extractRes.ok) throw new ImportError(502, "Extraction du document échouée.");

  const extractData = (await extractRes.json()) as { text?: string };
  if (!extractData.text?.trim()) throw new ImportError(422, "Aucun texte extrait du document.");
  return extractData.text;
}

/** Fait analyser une partie du document par l'IA. */
async function analysePart(
  document: PreparedDocument,
  part: AnalysisPart,
  userId: number | undefined,
): Promise<AiExtractionResult> {
  const { numberedText, paragraphCount } = buildNumberedText(document);
  const { scope, reminder } = buildPartInstructions(part, paragraphCount);
  const prompt = `${EXTRACT_VARIABLES_PROMPT_BASE}${scope}\n\nTEXTE DU CONTRAT :\n${numberedText}${reminder}`;

  let aiData: Gpt5Response;
  try {
    aiData = await callGpt5({
      prompt,
      // « low » plutôt que « medium » : même qualité sur nos essais, réponse bien plus rapide.
      reasoning: "low",
      verbosity: "low",
      model: "gpt-5.2",
    });
  } catch (error) {
    console.error("[template/import] analyse IA échouée :", (error as Error)?.message);
    throw new ImportError(502, "Analyse IA échouée.");
  }

  if (aiData.openai_tokens && userId) {
    await logOpenAiTokens({ openai_tokens: aiData.openai_tokens } as any, userId);
  }
  return keepPartOnly(parseAiExtraction(aiData.content ?? ""), document, part);
}

/** Répond au front après l'échec d'une étape de l'import. */
function sendImportError(res: Response, step: string, error: unknown): void {
  if (error instanceof ImportError) {
    res.status(error.status).json({ success: false, message: error.message });
    return;
  }
  console.error(`[template/import/${step}] error:`, (error as Error)?.message);
  if (!res.headersSent)
    res.status(500).json({ success: false, message: "Erreur interne lors de l'import." });
}

/**
 * Appelé dès l'ouverture de l'écran d'import : réveille le moteur Python, qui lit
 * le fichier. En ligne, il s'endort après quelques minutes sans visite et met
 * jusqu'à 15 s à redémarrer ; ce temps s'écoule pendant que l'internaute choisit son fichier.
 */
function handleImportWarmup(_req: Request, res: Response): void {
  fetch(`${BACKEND_URL}/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => {});
  res.status(204).end();
}

// ─── Génération d'un contrat « de zéro » ───────────────────────────────────────

/** Garde les entrées { question, answer } valides envoyées par le front. */
function readAnswers(raw: unknown): { question: string; answer: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => typeof item?.question === "string")
    .map((item) => ({
      question: item.question,
      answer: typeof item.answer === "string" ? item.answer : "",
    }));
}

/** Garde les parties valides (au minimum un rôle) envoyées par le front. */
function readParties(raw: unknown): PartyIdentity[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((party) => typeof party?.role === "string") as PartyIdentity[];
}

/** Garde les pièces jointes valides { name, text } envoyées par le front. */
function readAttachments(raw: unknown): BriefAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (attachment) => typeof attachment?.name === "string" && typeof attachment?.text === "string",
  );
}

/**
 * Étape 1 : questions de cadrage du contrat. Gratuit (pas de quota) : seule la
 * rédaction du contrat consomme un crédit.
 */
async function handleGenerateQuestions(req: Request, res: Response): Promise<void> {
  const { title } = req.body as { title?: string };
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ success: false, message: "Le champ 'title' est requis." });
    return;
  }

  try {
    // gpt-5.2 sans réflexion préalable : questions mieux ciblées que gpt-5.4-nano en « high »
    // (essais du 1er oct. 2026 : motif, échéance, essai pour un CDD ; type de bail, révision,
    // travaux pour un bail commercial) en 5 à 7 s au lieu de 26 s. « low » variait de 6 à 26 s.
    const data = await callGpt5({
      prompt: buildQuestionsPrompt(title),
      model: "gpt-5.2",
      reasoning: "none",
      verbosity: "low",
    });
    await withTracking("generate_contract_questions", logOpenAiTokens)(data, res.locals.userId as number | undefined);
    res.json(data);
  } catch (e) {
    console.error("[template/generate-questions]", (e as Error)?.message);
    res.status(502).json({ success: false, message: "Service IA momentanément indisponible" });
  }
}

/**
 * Étape 2 : rédaction du contrat. 1 rédaction = 1 crédit "generatorFromScratch".
 * Deux modes :
 *  - "questions" : depuis les réponses au questionnaire (`answers`) ;
 *  - "brief"     : depuis un besoin exprimé librement (`brief`, `attachments`).
 */
async function handleGenerateDraft(req: Request, res: Response): Promise<void> {
  const { mode, title, brief, includeRgpd } = req.body as {
    mode?: string;
    title?: string;
    brief?: string;
    includeRgpd?: boolean;
  };
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ success: false, message: "Le champ 'title' est requis." });
    return;
  }
  if (mode !== "questions" && mode !== "brief") {
    res.status(400).json({ success: false, message: "Le champ 'mode' doit valoir 'questions' ou 'brief'." });
    return;
  }

  // Quota : on vérifie AVANT de lancer l'IA.
  const userId = res.locals.userId as number | undefined;
  if (userId && !(await hasQuota("generatorFromScratch", userId))) {
    res.status(402).json({
      success: false,
      code: "QUOTA_EXCEEDED",
      message: "Quota de contrats générés épuisé. Passez à un plan supérieur pour continuer.",
    });
    return;
  }

  const parties = readParties(req.body?.parties);
  const withRgpd = includeRgpd !== false; // RGPD inclus par défaut
  const prompt =
    mode === "questions"
      ? buildDraftPrompt(title, readAnswers(req.body?.answers), parties, withRgpd)
      : buildBriefPrompt(
          title,
          typeof brief === "string" && brief.trim() ? brief : title,
          readAttachments(req.body?.attachments),
          parties,
          withRgpd,
        );

  try {
    // Profondeur "medium" et non "high" : la rédaction depuis une consigne libre
    // attendait nettement plus longtemps que le parcours par questions, pour un
    // résultat comparable. À réévaluer si la qualité des contrats produits baisse.
    const data = await callGpt5({ prompt, model: "gpt-5.2", reasoning: "medium", verbosity: "medium" });
    await withTracking("generate_contract_scratch", logOpenAiTokens)(data, userId);

    // Décrément après succès uniquement.
    if (userId) await consumeQuota("generatorFromScratch", userId, 1);

    res.json(data);
  } catch (e) {
    console.error("[template/generate-draft]", (e as Error)?.message);
    res.status(502).json({ success: false, message: "Service IA momentanément indisponible" });
  }
}

/** Étape 1 : lit le fichier, repère les emplacements vides et découpe le document en parties. */
async function handleImportPrepare(req: Request, res: Response): Promise<void> {
  const { fileBase64, filename } = req.body as {
    fileBase64?: string;
    filename?: string;
  };
  if (!fileBase64 || !filename) {
    res.status(400).json({ success: false, message: "fileBase64 et filename sont requis." });
    return;
  }

  // Quota : 1 import = 1 crédit "generatorImport". On vérifie dès la première
  // étape (avant tout appel IA) ; le crédit n'est décompté qu'à l'enregistrement.
  const userId = res.locals.userId as number | undefined;
  if (userId && !(await hasQuota("generatorImport", userId))) {
    res.status(402).json({
      success: false,
      code: "QUOTA_EXCEEDED",
      message: "Quota d'imports de modèles épuisé. Passez à un plan supérieur pour continuer.",
    });
    return;
  }

  try {
    const startedAt = Date.now();
    const document = prepareDocument(await extractDocumentText(fileBase64, filename));
    if (document.paragraphs.length === 0) throw new ImportError(422, "Aucun texte extrait du document.");

    const { paragraphCount, isTruncated } = buildNumberedText(document);
    if (isTruncated) {
      console.warn(`[template/import] document long : seuls les ${MAX_CHARS_SENT_TO_AI} premiers caractères sont analysés par l'IA.`);
    }
    const parts = splitIntoParts(document.paragraphs.slice(0, paragraphCount));

    // Aperçu immédiat : le texte complet, ses emplacements vides marqués « en cours ».
    const structure = buildTemplateStructure(document, EMPTY_EXTRACTION, placeholderIdsIn(document, parts));
    console.log(`[template/import] document lu en ${Date.now() - startedAt} ms : ${document.paragraphs.length} paragraphes, ${parts.length} partie(s) à analyser`);
    res.json({ success: true, data: { document, parts, structure } });
  } catch (e) {
    sendImportError(res, "prepare", e);
  }
}

/** Étape 2 : analyse d'une partie par l'IA (le front lance toutes les parties en même temps). */
async function handleImportAnalyse(req: Request, res: Response): Promise<void> {
  const document = readPreparedDocument(req.body?.document);
  const part = document && readPart(req.body?.part, document);
  if (!document || !part) {
    res.status(400).json({ success: false, message: "document et part valides sont requis." });
    return;
  }

  try {
    const startedAt = Date.now();
    const extraction = await analysePart(document, part, res.locals.userId as number | undefined);
    console.log(`[template/import] paragraphes ${part.first} à ${part.last} analysés en ${Date.now() - startedAt} ms`);
    res.json({ success: true, data: { extraction } });
  } catch (e) {
    sendImportError(res, "analyse", e);
  }
}

/** Étape 3 : aperçu avec les parties déjà analysées ; celles encore en cours restent marquées « en cours ». */
function handleImportAssemble(req: Request, res: Response): void {
  const document = readPreparedDocument(req.body?.document);
  if (!document) {
    res.status(400).json({ success: false, message: "document valide requis." });
    return;
  }

  try {
    const pendingParts = (Array.isArray(req.body?.pendingParts) ? req.body.pendingParts : [])
      .map((rawPart: unknown) => readPart(rawPart, document))
      .filter((part: AnalysisPart | null): part is AnalysisPart => part !== null);
    const extraction = mergeExtractions(readExtractions(req.body?.extractions));
    const structure = buildTemplateStructure(document, extraction, placeholderIdsIn(document, pendingParts));
    res.json({ success: true, data: { structure } });
  } catch (e) {
    sendImportError(res, "assemble", e);
  }
}

/** Étape 4 : assemblage définitif et enregistrement du modèle. */
async function handleImportFinalize(req: Request, res: Response): Promise<void> {
  const { fileBase64, filename, name, contractType } = req.body as {
    fileBase64?: string;
    filename?: string;
    name?: string;
    contractType?: string;
  };
  const document = readPreparedDocument(req.body?.document);
  if (!fileBase64 || !filename || !name || !document) {
    res.status(400).json({
      success: false,
      message: "fileBase64, filename, name et document sont requis.",
    });
    return;
  }

  try {
    const extraction = mergeExtractions(readExtractions(req.body?.extractions));
    const structure = buildTemplateStructure(document, extraction);

    const saveRes = await fetch(`${BACKNODE_URL}/template`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": process.env.INTERNAL_API_KEY || "",
        ...(res.locals.userId !== undefined
          ? {
            "x-user-id": String(res.locals.userId),
            "x-user-role": String(res.locals.role ?? "USER"),
          }
          : {}),
      },
      body: JSON.stringify({
        name,
        // Le type saisi par l'utilisateur est prioritaire, sinon celui déduit par l'IA.
        contractType: contractType || extraction.contractType || undefined,
        sourceFilename: filename,
        fileBase64,
        structure,
      }),
    });
    const saved = (await saveRes.json()) as { success?: boolean; data?: unknown };
    if (!saveRes.ok) {
      res.status(saveRes.status).json(saved);
      return;
    }

    const userId = res.locals.userId as number | undefined;
    if (userId) await consumeQuota("generatorImport", userId, 1);
    void trackFeature("import_template", userId);
    res.status(201).json({ success: true, data: { meta: saved.data, structure } });
  } catch (e) {
    sendImportError(res, "finalize", e);
  }
}
