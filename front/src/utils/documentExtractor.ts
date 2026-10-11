/* Extraction PDF avec serveur local et fallback PDF.js */
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/build/pdf.worker.entry";
import { cleanExtractedText, formatForClauseMatching } from "./textCleaner";
import { lightSanitize } from "./lightSanitize";
import FEATURE_FLAGS from "../config/features";
import { fetchProxy } from "./fetchProxy";
export interface ExtractedContent {
  text: string;
  html: string | null;
  isProtected: boolean;
  extractionQuality: "low" | "medium" | "high";
  metadata: Record<string, any>;
  clauses: any[];
}

// Fichier envoyé en base64 dans du JSON : chez o2switch, un envoi multipart
// contenant un fichier est détourné avant d'atteindre le relais (404), et
// l'écran retombait toujours sur PDF.js (ni Word, ni scans, ni mise en forme).
const PDF_SERVER_URL = `/api/user-uploads/extract-document-text-json`;
const MAX_RETRIES = 2;
const TIMEOUT_MS = 180000; // 3 minutes pour l'OCR

/**
 * Refus expliqué par le moteur (ancien .doc, PDF protégé, document vide) :
 * le message est montré tel quel, sans nouvel essai ni lecture de secours.
 */
export class DocumentRefuseError extends Error {}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Extrait le contenu d'un PDF via le serveur local (priorité) ou PDF.js (fallback)
 */
export async function extractDocumentContent(
  file: File,
): Promise<ExtractedContent> {
  // Essayer d'abord le serveur local avec gestion propre des annulations
  console.log("🔍 Tentative d'extraction via serveur local...");
  try {
    const result = await extractViaServer(file);
    console.log("HTML AFTER EXTRACT FROM SERVER ▶️▶️▶️ ", result);
    return result;
  } catch (error: any) {
    // Si c'est une annulation volontaire ou un refus expliqué, on propage l'erreur sans fallback
    if (error.name === "AbortError" || error instanceof DocumentRefuseError) {
      throw error;
    }

    console.warn(
      "⚠️ Serveur local indisponible, basculement vers PDF.js:",
      error,
    );
  }

  // Fallback vers PDF.js (ne fonctionnera pas pour les PDF scannés)
  console.log("🔄 Extraction via PDF.js (fallback)...");
  try {
    const result = await extractViaPDFJS(file); // ✅ Correction: extractViaPDFJS au lieu de extractViaPdfJs

    // Vérifier si PDF.js a réussi à extraire du texte
    if (!result.text || result.text.length === 0) {
      console.error("❌ PDF.js n'a pas pu extraire de texte (PDF scanné?)");
      throw new Error("PDF scanné détecté - serveur OCR requis");
    }

    return result;
  } catch (error) {
    console.error("❌ Échec de l'extraction PDF.js:", error);
    throw new Error(
      "Impossible d'extraire le texte du document. Pour les PDF scannés, assurez-vous que le serveur Python est démarré.",
    );
  }
}

/**
 * Extraction via serveur local
 */
async function extractViaServer(
  file: File,
  retries = MAX_RETRIES,
): Promise<ExtractedContent> {
  const body = JSON.stringify({
    filename: file.name,
    fileBase64: await fileToBase64(file),
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Créer un AbortController avec un timeout plus long pour les PDF scannés
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetchProxy(PDF_SERVER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.status === 422) {
        const refus = (await response.json().catch(() => ({}))) as {
          detail?: string;
        };
        throw new DocumentRefuseError(refus.detail || "Document illisible.");
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      // Vérifier que la réponse contient les données attendues
      if (!data.success) {
        throw new Error(data.error || "Extraction échouée");
      }

      if (!data.text) {
        throw new Error("Aucun texte extrait du document");
      }

      console.log(
        `✅ Extraction serveur réussie: ${data.text.length} caractères`,
      );

      return {
        // Texte déjà mis au propre par le moteur (le même que son HTML) : pas de
        // nettoyage supplémentaire, qui collait par exemple les guillemets aux mots.
        text: data.text,
        html: data.html || null,
        isProtected: false,
        extractionQuality: data.extraction_quality || "high",
        metadata: {
          filename: file.name,
          extractionMethod: "server",
          pages: data.pages || 1,
          keywords: data.keywords || [],
        },
        clauses: data.clauses || [],
      };
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error instanceof DocumentRefuseError) throw error;

      // Si c'est une annulation volontaire (changement de fichier), ne pas logger comme erreur
      if (error.name === "AbortError") {
        console.log(
          `⏹️ Tentative ${attempt}/${retries} annulée (nouveau fichier chargé)`,
        );
        // On arrête immédiatement sans réessayer
        throw error;
      }

      lastError = error;
      console.error(`❌ Tentative ${attempt}/${retries} échouée:`, error);

      if (attempt < retries) {
        // Attendre un peu avant de réessayer
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  throw lastError || new Error("Extraction échouée après plusieurs tentatives");
}

/**
 * Extraction via PDF.js (fallback)
 */
async function extractViaPDFJS(file: File): Promise<ExtractedContent> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      verbosity: 0, // Réduire les logs
    }).promise;

    const textPages: string[] = [];
    const totalPages = pdf.numPages;

    console.log(`📄 Extraction PDF.js: ${totalPages} pages`);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str)
          .join(" ")
          .trim();

        if (pageText) {
          textPages.push(`=== PAGE ${pageNum} ===`);
          textPages.push(pageText);
        }

        console.log(
          `📄 Page ${pageNum}/${totalPages} extraite (${pageText.length} caractères)`,
        );
      } catch (pageError) {
        console.warn(`⚠️ Erreur page ${pageNum}:`, pageError);
        continue;
      }
    }

    const rawText = textPages.join("\n\n").trim();

    // 🧹 NETTOYAGE ET REMISE EN FORME DU TEXTE
    console.log(
      `🧹 Nettoyage du texte extrait (${rawText.length} caractères bruts)...`,
    );
    const cleanedText = cleanExtractedText(rawText);
    const maybeSanitized = applyLightSanitizeIfEnabled(cleanedText, "pdfjs");
    const formattedText = formatForClauseMatching(maybeSanitized);

    console.log(
      `✅ Texte nettoyé: ${rawText.length} → ${formattedText.length} caractères`,
    );
    console.log(
      `📄 Aperçu du texte nettoyé: ${formattedText.substring(0, 200)}...`,
    );

    const quality =
      formattedText.length > 1000
        ? "high"
        : formattedText.length > 100
          ? "medium"
          : "low";

    console.log(
      `✅ Extraction PDF.js terminée: ${formattedText.length} caractères`,
    );

    return {
      text: formattedText,
      html: null,
      isProtected: formattedText.length === 0,
      extractionQuality: quality,
      metadata: {
        pages: totalPages,
        extractionMethod: "pdfjs",
        filename: file.name,
        fileSize: `${(file.size / 1024).toFixed(1)} KB`,
        originalLength: rawText.length,
        cleanedLength: formattedText.length,
      },
      clauses: [],
    };
  } catch (error) {
    console.error("❌ Erreur PDF.js:", error);
    throw new Error(`Extraction PDF.js échouée: ${error}`);
  }
}

/**
 * Applique lightSanitize conditionnellement et log le rapport.
 * Ne modifie pas la structure si aborted.
 */
function applyLightSanitizeIfEnabled(
  text: string,
  source: "server" | "pdfjs",
): string {
  if (!FEATURE_FLAGS.ENABLE_LIGHT_SANITIZE) return text;
  try {
    const { text: sanitized, report } = lightSanitize(text);
    console.log(`🧪 LightSanitize(${source})`, report);
    if (report.aborted) {
      console.warn(
        `⚠️ LightSanitize abort (ratio=${(report.ratioRemovedNonWhitespace * 100).toFixed(2)}%) → texte original conservé.`,
      );
      return text;
    }
    return sanitized;
  } catch (e) {
    console.warn("⚠️ LightSanitize erreur, fallback texte original", e);
    return text;
  }
}
