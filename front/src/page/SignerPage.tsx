import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Scale, Loader2, AlertCircle, CheckCircle2, Send, Download, FileText, ShieldCheck, Clock, XCircle, X } from "lucide-react";
import { PdfViewer } from "../components/DashboardComponents/signature/PdfViewer";
import { SignatureModal } from "../components/DashboardComponents/signature/SignatureModal";
import { SigningOtpModal } from "../components/DashboardComponents/signature/SigningOtpModal";
import { postSigningRequest } from "../components/DashboardComponents/signature/signingApi";
import { SIGNERS_DEFAULT } from "../components/DashboardComponents/signature/types";
import type { Field, FieldType, CapturedSignature } from "../components/DashboardComponents/signature/types";
import { fetchProxy } from "../utils/fetchProxy";

/**
 * Page publique de signature pour le cocontractant.
 * Accessible via /signer/:token — ne nécessite aucune authentification.
 *
 * Workflow :
 *  1. Charge l'enveloppe via GET /api/signature-envelope/public/:token
 *  2. Affiche le PDF avec les champs assignés au cocontractant
 *  3. Le cocontractant signe ses champs via la SignatureModal — signature et
 *     paraphes sont deux saisies distinctes, chacune remplit toutes ses zones
 *  4. Confirme son identité par un code reçu par e-mail (SigningOtpModal),
 *     puis soumet les champs signés via POST /api/signature-envelope/public/:token
 *
 * Il peut aussi refuser de signer. Le lien expire 14 jours après l'envoi.
 */

/** État de l'enveloppe vu par le cocontractant. */
type EnvelopeState = "TO_SIGN" | "SIGNED" | "EXPIRED" | "DECLINED" | "UNAVAILABLE";

function toEnvelopeState(status: string): EnvelopeState {
  if (status === "SENT") return "TO_SIGN";
  if (status === "SIGNED") return "SIGNED";
  if (status === "EXPIRED") return "EXPIRED";
  if (status === "DECLINED") return "DECLINED";
  return "UNAVAILABLE";
}
export function SignerPage() {
  const { token } = useParams<{ token: string }>();

  // ── Chargement initial ────────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [documentName, setDocumentName] = useState("");
  // Noms des deux parties : affichés dans le récapitulatif de confirmation.
  const [selfName, setSelfName] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [counterpartyEmail, setCounterpartyEmail] = useState("");
  const [envelopeState, setEnvelopeState] = useState<EnvelopeState>("TO_SIGN");
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [fields, setFields] = useState<Field[]>([]);

  // ── Signature ─────────────────────────────────────────────────────────────
  // Une saisie par type : la signature complète et le paraphe (initiales) sont
  // deux images différentes.
  const [capturedByType, setCapturedByType] = useState<Record<FieldType, CapturedSignature | null>>({
    signature: null, initial: null,
  });
  const [modalOpenFor, setModalOpenFor] = useState<Field | null>(null);

  // ── Soumission ────────────────────────────────────────────────────────────
  const [otpModalOpen, setOtpModalOpen] = useState(false);
  const [declineModalOpen, setDeclineModalOpen] = useState(false);

  // ── Téléchargement du contrat signé ───────────────────────────────────────
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  // Signataires (on réutilise SIGNERS_DEFAULT pour les couleurs)
  const signers = SIGNERS_DEFAULT;

  useEffect(() => {
    if (!token) { setLoadError("Lien invalide."); setLoading(false); return; }

    void (async () => {
      try {
        const res = await fetchProxy(`/api/signature-envelope/public/${token}`);
        const data = await res.json() as {
          success: boolean;
          message?: string;
          data?: {
            meta: {
              documentName: string;
              numPages: number;
              status: string;
              selfName?: string;
              counterpartyName?: string;
              counterpartyEmail?: string;
            };
            fields: { fields: Field[] };
            fileBase64: string | null;
          };
        };
        if (!res.ok || !data.success || !data.data) {
          throw new Error(data.message ?? "Lien invalide ou expiré.");
        }
        setDocumentName(data.data.meta.documentName);
        setSelfName(data.data.meta.selfName ?? "");
        setCounterpartyName(data.data.meta.counterpartyName ?? "");
        setCounterpartyEmail(data.data.meta.counterpartyEmail ?? "");
        setEnvelopeState(toEnvelopeState(data.data.meta.status));

        // Convertit base64 → File
        if (data.data.fileBase64) {
          const bytes = Uint8Array.from(atob(data.data.fileBase64), (c) => c.charCodeAt(0));
          const blob = new Blob([bytes], { type: "application/pdf" });
          setPdfFile(new File([blob], data.data.meta.documentName, { type: "application/pdf" }));
        }

        // Garde uniquement les champs du cocontractant
        const all: Field[] = data.data.fields.fields ?? [];
        setFields(all);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Erreur réseau.");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // ── Champs cocontractant non encore signés ────────────────────────────────
  const counterFields = fields.filter((f) => f.signer === "counterparty");
  const unsignedCounter = counterFields.filter((f) => !f.value);
  const allSigned = counterFields.length > 0 && unsignedCounter.length === 0;

  const hasInitialFields = counterFields.some((f) => f.type === "initial");

  function handleFieldClick(field: Field) {
    if (field.signer !== "counterparty") return;
    const captured = capturedByType[field.type];
    if (captured) {
      applySignature(field, captured);
    } else {
      setModalOpenFor(field);
    }
  }

  /**
   * Applique la saisie au champ cliqué et à tous les champs vides du même type
   * (une seule saisie de paraphe remplit toutes les pages). Seule la signature
   * est datée : un paraphe ne porte pas de date.
   *
   * S'il reste ensuite des champs vides de l'autre type, la modale s'ouvre
   * aussitôt pour eux : le cocontractant n'a pas à les chercher page par page.
   */
  function applySignature(field: Field, sig: CapturedSignature) {
    const signedAt = field.type === "signature" ? new Date().toISOString() : undefined;
    const next = fields.map((f) => {
      const isTarget = f.id === field.id
        || (f.signer === "counterparty" && f.type === field.type && !f.value);
      if (!isTarget) return f;
      return { ...f, value: sig.dataUrl, ...(signedAt ? { signedAt } : {}) };
    });
    setFields(next);

    const nextToComplete = next.find((f) => f.signer === "counterparty" && !f.value);
    setModalOpenFor(nextToComplete ?? null);
  }

  function handleModalConfirm(sig: CapturedSignature) {
    if (!modalOpenFor) return;
    setCapturedByType((prev) => ({ ...prev, [modalOpenFor.type]: sig }));
    applySignature(modalOpenFor, sig);
  }

  /** Demande l'envoi du code OTP au cocontractant. */
  function requestCounterpartyCode() {
    return postSigningRequest(fetchProxy, `/api/signature-envelope/public/${token}/otp`);
  }

  /** Valide la signature avec le code : les deux parties ont alors signé. */
  async function confirmCounterpartySignature(code: string) {
    const result = await postSigningRequest(fetchProxy, `/api/signature-envelope/public/${token}`, {
      fields: { fields },
      code,
      consentAccepted: true,
    });
    if (result.success) {
      setOtpModalOpen(false);
      setEnvelopeState("SIGNED");
    } else if (result.code === "EXPIRED") {
      setOtpModalOpen(false);
      setEnvelopeState("EXPIRED");
    }
    return result;
  }

  /**
   * Télécharge le contrat signé (PDF original + signatures incrustées) depuis
   * la route publique. Le token de signature sert d'autorisation : il donne
   * déjà accès au document.
   */
  async function handleDownload() {
    if (!token) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const res = await fetchProxy(`/api/signature-envelope/public/${token}/download`);
      if (!res.ok) throw new Error("Le téléchargement a échoué.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${documentName.replace(/\.pdf$/i, "")}_signe.pdf`;
      // Le lien doit être dans le document et l'URL libérée après coup :
      // certains navigateurs annulent le téléchargement sinon.
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Le téléchargement a échoué.");
    } finally {
      setDownloading(false);
    }
  }

  // ── Renders ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Screen>
        <Loader2 className="w-8 h-8 animate-spin text-[#354F99]" />
        <p className="text-sm text-gray-500 mt-3">Chargement du document…</p>
      </Screen>
    );
  }

  if (loadError) {
    return (
      <Screen>
        <div className="w-16 h-16 rounded-2xl bg-red-50 flex items-center justify-center mb-4">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-base font-bold text-gray-800">Lien invalide</h2>
        <p className="text-sm text-gray-500 mt-1 max-w-sm text-center">{loadError}</p>
      </Screen>
    );
  }

  if (envelopeState === "EXPIRED" || envelopeState === "DECLINED" || envelopeState === "UNAVAILABLE") {
    const messages = {
      EXPIRED: {
        title: "Lien expiré",
        text: "Ce lien de signature n'est plus valable. Demandez à l'émetteur de vous renvoyer une invitation.",
      },
      DECLINED: { title: "Signature refusée", text: "Vous avez refusé de signer ce document." },
      UNAVAILABLE: { title: "Document indisponible", text: "Ce document ne peut plus être signé." },
    };
    const message = messages[envelopeState];
    return (
      <Screen>
        <div className="w-16 h-16 rounded-2xl bg-surface-muted flex items-center justify-center mb-4">
          {envelopeState === "EXPIRED"
            ? <Clock className="w-8 h-8 text-ink-muted" />
            : <XCircle className="w-8 h-8 text-ink-muted" />}
        </div>
        <h2 className="text-base font-bold text-gray-800">{message.title}</h2>
        <p className="text-sm text-gray-500 mt-1 max-w-sm text-center">{message.text}</p>
      </Screen>
    );
  }

  if (envelopeState === "SIGNED") {
    return (
      <SignedConfirmation
        documentName={documentName}
        selfName={selfName}
        counterpartyName={counterpartyName}
        downloading={downloading}
        downloadError={downloadError}
        onDownload={() => void handleDownload()}
      />
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f9fb]" style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
      <PublicHeader documentName={documentName} />

      <main className="max-w-5xl mx-auto p-4 lg:p-6 space-y-4">
        {/* Barre de progression + bouton envoyer */}
        <div className="bg-blue-primary rounded-2xl border border-gray-200 p-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-white">
              Vos champs à signer
            </p>
            <p className="text-xs text-gray-primary">
              {counterFields.length - unsignedCounter.length}/{counterFields.length} complétés
              {counterFields.length === 0 && " — aucun champ à signer"}
            </p>
          </div>
          <div className="flex w-full sm:w-auto flex-col-reverse sm:flex-row gap-2">
            <button
              onClick={() => setDeclineModalOpen(true)}
              className="flex justify-center items-center px-4 py-2.5 text-sm font-semibold text-white/80 rounded-xl border border-white/20 hover:bg-white/10 transition-all"
            >
              Refuser de signer
            </button>
            <button
              onClick={() => setOtpModalOpen(true)}
              disabled={!allSigned}
              className="flex justify-center items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white text-sm font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
            >
              <Send className="w-4 h-4" />
              Valider ma signature
            </button>
          </div>
        </div>

        {/* Instruction */}
        {!allSigned && counterFields.length > 0 && (
          <p className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-2.5">
            {hasInitialFields ? (
              <>
                Cliquez sur les zones en <strong>vert</strong> pour apposer votre signature et
                vos paraphes. Une seule saisie remplit toutes les pages.
              </>
            ) : (
              <>Cliquez sur les zones en <strong>vert</strong> pour apposer votre signature.</>
            )}
          </p>
        )}

        {/* PDF viewer */}
        <div className="bg-white rounded-2xl border border-gray-200 p-2 sm:p-4">
          <PdfViewer
            file={pdfFile}
            fields={fields}
            signers={signers}
            mode="sign"
            onFieldClick={handleFieldClick}
          />
        </div>
      </main>

      <SigningOtpModal
        open={otpModalOpen}
        recipientEmail={counterpartyEmail}
        documentName={documentName}
        accentHex="#10b981"
        onRequestCode={requestCounterpartyCode}
        onConfirm={confirmCounterpartySignature}
        onClose={() => setOtpModalOpen(false)}
      />

      <DeclineModal
        open={declineModalOpen}
        token={token ?? ""}
        onClose={() => setDeclineModalOpen(false)}
        onDeclined={() => { setDeclineModalOpen(false); setEnvelopeState("DECLINED"); }}
      />

      {/* Modale de signature */}
      {modalOpenFor && (
        <SignatureModal
          open={true}
          // Une modale neuve par type : sans cela, le dessin de la signature
          // resterait sur le canevas du paraphe quand on enchaîne les deux.
          key={modalOpenFor.type}
          signerName={counterpartyName || "Cocontractant"}
          signerHex="#10b981"
          kind={modalOpenFor.type}
          initialSignature={capturedByType[modalOpenFor.type]}
          onClose={() => setModalOpenFor(null)}
          onConfirm={handleModalConfirm}
        />
      )}
    </div>
  );
}

/** Bandeau de marque des pages publiques de signature. */
function PublicHeader({ documentName }: { documentName: string }) {
  return (
    <header className="h-14 bg-blue-primary flex items-center px-4 sm:px-6 gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-panel bg-brand">
        <Scale className="h-4 w-4 text-white" />
      </div>
      <span className="text-sm font-bold text-white shrink-0">Lumen Juris</span>
      <span className="text-white/30 mx-1">·</span>
      <span className="text-sm text-white/70 truncate min-w-0 max-w-xs">
        Signature{documentName ? ` — ${documentName}` : ""}
      </span>
    </header>
  );
}

/**
 * Écran de fin de parcours du cocontractant : confirmation que le document est
 * signé par les deux parties, et remise immédiate du contrat signé.
 *
 * Le téléchargement est proposé ici parce que c'est le moment où le
 * cocontractant en a besoin : il vient de signer, il n'a pas de compte sur la
 * plateforme et l'e-mail de confirmation peut tarder ou finir en indésirables.
 */
function SignedConfirmation({
  documentName, selfName, counterpartyName,
  downloading, downloadError, onDownload,
}: {
  documentName: string;
  selfName: string;
  counterpartyName: string;
  downloading: boolean;
  downloadError: string;
  onDownload: () => void;
}) {
  const signedOn = new Date().toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div
      className="min-h-screen bg-surface-subtle flex flex-col"
      style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      <PublicHeader documentName={documentName} />

      <main className="flex-1 flex items-start justify-center p-4 lg:p-8">
        <div className="w-full max-w-lg bg-white rounded-card border border-line shadow-card-md overflow-hidden">
          {/* Bandeau de réussite */}
          <div className="bg-success-light px-6 py-7 flex flex-col items-center text-center gap-3 border-b border-line-subtle">
            <div className="w-14 h-14 rounded-card bg-white flex items-center justify-center shadow-card">
              <CheckCircle2 className="w-7 h-7 text-success stroke-[1.5]" />
            </div>
            <div className="space-y-1">
              <h1 className="text-xl font-bold text-ink tracking-tight">Document signé</h1>
              <p className="text-sm text-success-dark">
                Signature enregistrée le {signedOn}
              </p>
            </div>
          </div>

          <div className="p-6 space-y-5">
            {/* Document concerné */}
            <div className="flex items-start gap-3 rounded-panel bg-surface-subtle border border-line-subtle px-4 py-3">
              <FileText className="w-4 h-4 text-ink-subtle shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest">
                  Document
                </p>
                <p className="text-sm font-semibold text-ink break-words">{documentName}</p>
              </div>
            </div>

            {/* Récapitulatif des signataires */}
            <div className="space-y-2">
              <p className="text-[10px] font-bold text-ink-subtle uppercase tracking-widest">
                Signataires
              </p>
              <SignerLine label={selfName || "Émetteur"} role="Émetteur" />
              <SignerLine label={counterpartyName || "Vous"} role="Cocontractant" />
            </div>

            {/* Remise du contrat signé */}
            <div className="space-y-2">
              <button
                onClick={onDownload}
                disabled={downloading}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 bg-brand text-white text-sm font-semibold rounded-panel hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-card"
              >
                {downloading
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Download className="w-4 h-4" />}
                {downloading ? "Préparation du PDF…" : "Télécharger le contrat signé"}
              </button>
              {downloadError && (
                <p className="flex items-center gap-1.5 text-xs text-danger-dark">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  {downloadError}
                </p>
              )}
              <p className="text-xs text-ink-muted leading-relaxed text-center">
                Une copie du contrat signé et le dossier de preuve vous sont également envoyés par e-mail.
              </p>
            </div>

            {/* Valeur probante — rassure sur ce qui vient d'être fait */}
            <div className="flex items-start gap-2.5 rounded-panel bg-brand-light px-4 py-3">
              <ShieldCheck className="w-4 h-4 text-brand shrink-0 mt-0.5" />
              <p className="text-xs text-ink-secondary leading-relaxed">
                Votre identité a été vérifiée par code et chaque étape est horodatée dans un
                journal de preuve. Conservez le contrat et le dossier de preuve reçus par e-mail.
              </p>
            </div>
          </div>
        </div>
      </main>

      <footer className="py-5 text-center text-xs text-ink-subtle">
        Signature électronique propulsée par <span className="font-semibold text-ink-muted">Lumen Juris</span>
      </footer>
    </div>
  );
}

/** Modale de refus : le motif est facultatif et inscrit au journal de preuve. */
function DeclineModal({
  open, token, onClose, onDeclined,
}: {
  open: boolean;
  token: string;
  onClose: () => void;
  onDeclined: () => void;
}) {
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  async function handleDecline() {
    setDeclining(true);
    setError("");
    try {
      const result = await postSigningRequest(
        fetchProxy,
        `/api/signature-envelope/public/${token}/decline`,
        { reason },
      );
      if (result.success) onDeclined();
      else setError(result.message || "Le refus n'a pas pu être enregistré.");
    } catch {
      setError("Erreur réseau : réessayez.");
    } finally {
      setDeclining(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => !declining && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h3 className="text-sm font-bold text-gray-900">Refuser de signer ce document ?</h3>
          <button type="button" onClick={onClose} aria-label="Fermer" className="text-gray-300 hover:text-gray-500">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-6 py-5 space-y-2">
          <label htmlFor="decline-reason" className="text-xs font-semibold text-gray-600">
            Motif (facultatif)
          </label>
          <textarea
            id="decline-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="Ex : la clause 4 doit être revue avant signature."
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-gray-300 focus:bg-white transition resize-none"
          />
          <p className="text-[11px] text-gray-400">Ce refus est définitif pour ce lien de signature.</p>
          {error && <p className="text-[11px] text-danger-dark">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={declining}
            className="px-4 py-2 text-sm font-semibold text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            Annuler
          </button>
          <button
            type="button"
            onClick={() => void handleDecline()}
            disabled={declining}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-danger rounded-xl hover:bg-danger-dark disabled:opacity-40 transition-colors shadow-sm"
          >
            {declining && <Loader2 className="w-4 h-4 animate-spin" />}
            Refuser de signer
          </button>
        </div>
      </div>
    </div>
  );
}

/** Une ligne « nom — rôle » du récapitulatif des signataires. */
function SignerLine({ label, role }: { label: string; role: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-panel border border-line-subtle px-3 py-2">
      <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
      <span className="text-sm font-medium text-ink truncate">{label}</span>
      <span className="ml-auto text-[10px] font-semibold text-ink-subtle uppercase tracking-wide shrink-0">
        {role}
      </span>
    </div>
  );
}

/** Centrage vertical pour les états loading/error/done. */
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-[#f8f9fb]"
      style={{ fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#354F99] mb-6">
        <Scale className="h-5 w-5 text-white" />
      </div>
      {children}
    </div>
  );
}
