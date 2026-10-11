/* hooks/useContractAnalysis.ts
 * Hook personnalisé pour la gestion de l'analyse des contrats
 * Extrait la logique métier de App.tsx
 */

import { useState, useCallback, useRef } from "react";
import type { ClauseRisk, ContractAnalysis } from "../types";
import type { AnalysisContext } from "../types/contextualAnalysis";
import {
  DocumentRefuseError,
  extractDocumentContent,
} from "../utils/documentExtractor";
import type { AnalysisProgress } from "../types/analysisProgress";
import {
  performCompleteMarketAnalysis,
  MarketAnalysisResult,
} from "../utils/marketAnalysis";
import { useDocumentTextStore } from "../store/documentTextStore";
// import { triggerPostAnalysisJournal } from '../utils/analysisLogger';

export type ProcessingPhase =
  | "upload"
  | "extraction"
  | "analysis"
  | "scoring"
  | "report"
  | "contextual"
  | "enhanced";

interface UseContractAnalysisReturn {
  contract: ContractAnalysis | null;
  isProcessing: boolean;
  processingPhase: ProcessingPhase;
  analysisProgress: AnalysisProgress | null;
  currentAnalysisContext: AnalysisContext | null;
  marketAnalysis: MarketAnalysisResult | null;
  isMarketAnalysisLoading: boolean;
  handleFileUpload: (file: File) => Promise<ContractAnalysis | null>;
  handleTextSubmit: (
    text: string,
    fileName: string,
  ) => Promise<ContractAnalysis | null>;
  handleMarketAnalysis: () => Promise<void>;
  restoreAnalysis: (state: {
    contract: ContractAnalysis;
    currentAnalysisContext: AnalysisContext | null;
    marketAnalysis: MarketAnalysisResult | null;
  }) => void;
  resetAnalysis: () => void;
}

type ExtractionMetadataInput = {
  pages?: number;
  extraction_time?: string;
  isProtected?: boolean;
  extractionQuality?: NonNullable<
    ContractAnalysis["extractionMetadata"]
  >["extractionQuality"];
};

type RawClauseRisk = Omit<ClauseRisk, "category"> & {
  category?: unknown;
};

const CLAUSE_CATEGORIES = [
  "penalty",
  "termination",
  "responsibility",
  "confidentiality",
  "nonCompete",
  "warranty",
  "other",
] as const satisfies readonly ClauseRisk["category"][];

function normalizeClauseCategory(category: unknown): ClauseRisk["category"] {
  return typeof category === "string" &&
    (CLAUSE_CATEGORIES as readonly string[]).includes(category)
    ? (category as ClauseRisk["category"])
    : "other";
}

export function processContractAnalysisResults(
  baseContract: ContractAnalysis,
  analysisResults: RawClauseRisk[],
  analysisType: "standard" | "contextual",
  context?: AnalysisContext,
  isSensitive?: boolean,
): ContractAnalysis {
  const processedClauses: ClauseRisk[] = analysisResults.map((clause) => ({
    ...clause,
    category: normalizeClauseCategory(clause.category),
  }));

  return {
    ...baseContract,
    clauses: processedClauses,
    isSensitive: isSensitive ?? true,
    overallRiskScore:
      analysisResults.length > 0
        ? analysisResults.reduce((sum, c) => sum + c.riskScore, 0) /
          analysisResults.length
        : 0,
    contractType:
      analysisType === "contextual"
        ? context?.contractType?.trim() || "Contrat analysé"
        : "Contrat analysé",
    processed: true,
    aiConfidenceScore: analysisType === "contextual" ? 90 : 85,
    extractionMetadata: {
      ...baseContract.extractionMetadata,
      wordCount: baseContract.extractionMetadata?.wordCount || 0,
      language: baseContract.extractionMetadata?.language || "fr",
      extractionMethod:
        baseContract.extractionMetadata?.extractionMethod || "text",
      fileSize: baseContract.extractionMetadata?.fileSize || "0KB",
      extractionTime: baseContract.extractionMetadata?.extractionTime || "0ms",
      aiSummary:
        analysisResults.length > 0
          ? `${analysisResults.length} clauses à risque identifiées${analysisType === "contextual" ? " avec contexte" : ""}`
          : "Aucune clause à risque identifiée",
    },
    ...(analysisType === "contextual" && context
      ? {
          reponses_questions_mandant: {
            contractType: context.contractType,
            userRole: context.userRole,
            missionContext: context.missionContext || "",
            specificQuestions: context.specificQuestions,
          },
        }
      : {}),
  };
}

export const useContractAnalysis = (): UseContractAnalysisReturn => {
  const [contract, setContract] = useState<ContractAnalysis | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const activeOperationRef = useRef(0);
  const setHtmlContent = useDocumentTextStore((s) => s.setHtmlContent);
  const [processingPhase, setProcessingPhase] =
    useState<ProcessingPhase>("extraction");
  const [analysisProgress, setAnalysisProgress] =
    useState<AnalysisProgress | null>(null);
  const [currentAnalysisContext, setCurrentAnalysisContext] =
    useState<AnalysisContext | null>(null);
  const [marketAnalysis, setMarketAnalysis] =
    useState<MarketAnalysisResult | null>(null);
  const [isMarketAnalysisLoading, setIsMarketAnalysisLoading] = useState(false);

  const beginOperation = useCallback(() => {
    activeOperationRef.current += 1;
    return activeOperationRef.current;
  }, []);

  const isCurrentOperation = useCallback((operationId: number) => {
    return activeOperationRef.current === operationId;
  }, []);

  const createBaseContract = useCallback(
    (
      fileName: string,
      content: string,
      extractionMethod: string = "direct_input",
      metadata?: ExtractionMetadataInput,
    ): ContractAnalysis => {
      return {
        id: Date.now().toString(),
        fileName,
        uploadDate: new Date(),
        content,
        clauses: [],
        overallRiskScore: 0,
        riskProfile: "conservative",
        processed: false,
        jurisdiction: "France",
        contractType: "",
        aiConfidenceScore: 0,
        reviewHistory: [],
        extractionMetadata: {
          pages: metadata?.pages ?? 1,
          wordCount: content.split(/\s+/).length,
          language: "fr",
          extractionMethod,
          fileSize: `${(content.length / 1024).toFixed(1)} KB`,
          extractionTime: metadata?.extraction_time ?? new Date().toISOString(),
          protectionDetected: metadata?.isProtected ?? false,
          isProtected: metadata?.isProtected ?? false,
          extractionQuality: metadata?.extractionQuality ?? "high",
          aiSummary: "",
        },
      };
    },
    [],
  );

  const handleFileUpload = useCallback(
    async (file: File) => {
      // Log supprimé pour de meilleures performances
      const operationId = beginOperation();

      setIsProcessing(true);
      setProcessingPhase("extraction");
      setAnalysisProgress(null);
      setContract(null);
      setCurrentAnalysisContext(null);

      try {
        const extractedContent = await extractDocumentContent(file);
        if (!isCurrentOperation(operationId)) return null;

        setHtmlContent(extractedContent.html);

        const tempContract = createBaseContract(
          file.name,
          extractedContent.text,
          extractedContent.metadata?.extraction_method ?? "ocr",
          {
            pages: extractedContent.metadata?.pages ?? 0,
            extraction_time: extractedContent.metadata?.extraction_time,
            isProtected: extractedContent.isProtected,
            extractionQuality: extractedContent.extractionQuality,
          },
        );

        setContract(tempContract);
        // Log supprimé pour de meilleures performances
        return tempContract;
      } catch (err) {
        if (!isCurrentOperation(operationId)) return null;

        console.error("Erreur lors de l'extraction:", err);
        throw new Error(
          err instanceof DocumentRefuseError
            ? err.message
            : "Échec de l'extraction du texte. Assurez-vous que le PDF n'est pas protégé et réessayez.",
        );
      } finally {
        if (isCurrentOperation(operationId)) {
          setIsProcessing(false);
        }
      }
    },
    [beginOperation, createBaseContract, isCurrentOperation, setHtmlContent],
  );

  const handleTextSubmit = useCallback(
    async (text: string, fileName: string) => {
      beginOperation();

      console.log(
        "📝 Soumission de texte direct:",
        fileName,
        text.length,
        "caractères",
      );

      setIsProcessing(false);
      setAnalysisProgress(null);
      setContract(null);
      setCurrentAnalysisContext(null);

      try {
        const tempContract = createBaseContract(fileName, text);
        setContract(tempContract);
        console.log("✅ Texte préparé, formulaire prêt");
        return tempContract;
      } catch (error) {
        console.error("❌ Erreur lors de la préparation du texte:", error);
        throw new Error(
          "Erreur lors de la préparation du texte. Veuillez réessayer.",
        );
      }
    },
    [beginOperation, createBaseContract],
  );

  const handleMarketAnalysis = useCallback(async () => {
    if (!contract || !currentAnalysisContext) {
      throw new Error(
        "Contrat et contexte d'analyse requis pour l'analyse de marché",
      );
    }

    const operationId = beginOperation();
    setIsMarketAnalysisLoading(true);

    try {
      console.log("🔍 Lancement de l'analyse comparative de marché...");

      const marketResult = await performCompleteMarketAnalysis(
        contract.content,
        currentAnalysisContext.contractType,
        contract.clauses,
      );
      if (!isCurrentOperation(operationId)) return;

      setMarketAnalysis(marketResult);
      console.log("✅ Analyse de marché terminée:", marketResult);
    } catch (error) {
      if (!isCurrentOperation(operationId)) return;

      console.error("❌ Erreur lors de l'analyse de marché:", error);
      throw new Error(
        "Erreur lors de l'analyse comparative. Veuillez réessayer.",
      );
    } finally {
      if (isCurrentOperation(operationId)) {
        setIsMarketAnalysisLoading(false);
      }
    }
  }, [beginOperation, contract, currentAnalysisContext, isCurrentOperation]);

  const resetAnalysis = useCallback(() => {
    activeOperationRef.current += 1;
    setContract(null);
    setCurrentAnalysisContext(null);
    setMarketAnalysis(null);
    setIsProcessing(false);
    setAnalysisProgress(null);
    setIsMarketAnalysisLoading(false);
    setProcessingPhase("extraction");
  }, []);

  const restoreAnalysis = useCallback(
    ({
      contract,
      currentAnalysisContext,
      marketAnalysis,
    }: {
      contract: ContractAnalysis;
      currentAnalysisContext: AnalysisContext | null;
      marketAnalysis: MarketAnalysisResult | null;
    }) => {
      activeOperationRef.current += 1;
      setContract(contract);
      setCurrentAnalysisContext(currentAnalysisContext);
      setMarketAnalysis(marketAnalysis);
      setIsProcessing(false);
      setAnalysisProgress(null);
      setIsMarketAnalysisLoading(false);
      setProcessingPhase(contract.processed ? "report" : "extraction");
    },
    [],
  );

  return {
    contract,
    isProcessing,
    processingPhase,
    analysisProgress,
    currentAnalysisContext,
    marketAnalysis,
    isMarketAnalysisLoading,
    handleFileUpload,
    handleTextSubmit,
    handleMarketAnalysis,
    restoreAnalysis,
    resetAnalysis,
  };
};
