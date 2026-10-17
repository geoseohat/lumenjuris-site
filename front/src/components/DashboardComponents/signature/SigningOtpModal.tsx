import { useEffect, useRef, useState } from "react";
import { X, ShieldCheck, Loader2 } from "lucide-react";

import type { OtpApiResult } from "./signingApi";

interface Props {
  open: boolean;
  /** Adresse qui reçoit le code (affichée pour que le signataire sache où regarder). */
  recipientEmail?: string;
  documentName: string;
  /** Couleur du signataire, pour rester cohérent avec ses zones sur le PDF. */
  accentHex: string;
  /** Demande l'envoi d'un code par e-mail. */
  onRequestCode: () => Promise<OtpApiResult>;
  /** Valide la signature avec le code saisi (le consentement est forcément coché). */
  onConfirm: (code: string) => Promise<OtpApiResult>;
  onClose: () => void;
}

/** Délai avant de pouvoir redemander un code (identique au back). */
const RESEND_DELAY_SECONDS = 60;

/** Erreurs après lesquelles le code saisi ne peut plus servir : il en faut un nouveau. */
const CODE_UNUSABLE_ERRORS = ["OTP_EXPIRED", "OTP_TOO_MANY_ATTEMPTS", "OTP_NO_CODE"];

/**
 * Modale de confirmation d'identité avant de signer.
 *
 * 1. Un code à 6 chiffres est envoyé par e-mail dès l'ouverture.
 * 2. Le signataire coche le consentement à la signature électronique.
 * 3. Il saisit le code : c'est ce qui valide juridiquement sa signature
 *    (voir backNode/documentation/signature_journal.md).
 *
 * Utilisée par l'émetteur (wizard) et par le cocontractant (page /signer).
 */
export function SigningOtpModal({
  open, recipientEmail, documentName, accentHex, onRequestCode, onConfirm, onClose,
}: Props) {
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const [secondsBeforeResend, setSecondsBeforeResend] = useState(0);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  // À chaque ouverture : on repart de zéro et on envoie un premier code.
  useEffect(() => {
    if (!open) return;
    setConsentAccepted(false);
    setCode("");
    setCodeSent(false);
    setError("");
    void requestCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Compte à rebours avant de pouvoir redemander un code.
  useEffect(() => {
    if (secondsBeforeResend <= 0) return;
    const timer = setTimeout(() => setSecondsBeforeResend((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsBeforeResend]);

  // Échap ferme la modale, comme les autres modales de l'application.
  useEffect(() => {
    if (!open) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !confirming) onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [open, confirming, onClose]);

  async function requestCode() {
    setSendingCode(true);
    setError("");
    try {
      const result = await onRequestCode();
      if (result.success) {
        setCodeSent(true);
        setSecondsBeforeResend(RESEND_DELAY_SECONDS);
        setCode("");
        codeInputRef.current?.focus();
      } else {
        setError(result.message || "Impossible d'envoyer le code.");
        if (result.retryAfterSeconds) setSecondsBeforeResend(result.retryAfterSeconds);
        // Un code envoyé il y a moins d'une minute est toujours valable.
        if (result.code === "TOO_SOON") setCodeSent(true);
      }
    } catch {
      setError("Erreur réseau : le code n'a pas pu être envoyé.");
    } finally {
      setSendingCode(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canConfirm) return;
    setConfirming(true);
    setError("");
    try {
      const result = await onConfirm(code);
      if (result.success) return; // le parent ferme la modale
      if (result.code === "OTP_WRONG_CODE" && result.attemptsLeft !== undefined) {
        setError(`Code incorrect. Il vous reste ${result.attemptsLeft} essai${result.attemptsLeft > 1 ? "s" : ""}.`);
      } else {
        setError(result.message || "La signature n'a pas pu être validée.");
      }
      if (result.code && CODE_UNUSABLE_ERRORS.includes(result.code)) setCode("");
    } catch {
      setError("Erreur réseau : réessayez.");
    } finally {
      setConfirming(false);
    }
  }

  if (!open) return null;

  const canConfirm = consentAccepted && /^\d{6}$/.test(code) && !confirming;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => !confirming && onClose()}
      style={{ animation: "fadeIn 0.15s ease-out" }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
        style={{ animation: "scaleIn 0.2s ease-out" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: accentHex + "20" }}
            >
              <ShieldCheck className="w-4 h-4" style={{ color: accentHex }} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">Confirmez votre signature</h3>
              <p className="text-[11px] text-gray-400 mt-0.5 break-all">{documentName}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            aria-label="Fermer"
            className="text-gray-300 hover:text-gray-500 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Code reçu par e-mail */}
          <div className="space-y-1.5">
            <label htmlFor="signing-otp-code" className="text-xs font-semibold text-gray-600">
              Code de vérification
            </label>
            <p className="text-[11px] text-gray-400 leading-relaxed">
              {!codeSent
                ? (sendingCode ? "Envoi du code en cours…" : "Aucun code n'a encore été envoyé.")
                : <>
                    Un code à 6 chiffres a été envoyé
                    {recipientEmail ? <> à <span className="font-semibold text-gray-500 break-all">{recipientEmail}</span></> : null}.
                    Il est valable 10 minutes.
                  </>}
            </p>
            <input
              id="signing-otp-code"
              ref={codeInputRef}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] text-gray-800 outline-none focus:border-gray-300 focus:bg-white transition"
            />
            <button
              type="button"
              onClick={() => void requestCode()}
              disabled={sendingCode || secondsBeforeResend > 0}
              className="text-[11px] font-semibold text-brand hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
            >
              {secondsBeforeResend > 0
                ? `Renvoyer un code dans ${secondsBeforeResend} s`
                : "Je n'ai rien reçu : renvoyer un code"}
            </button>
          </div>

          {/* Consentement à la signature électronique */}
          <label className="flex items-start gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 cursor-pointer">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(e) => setConsentAccepted(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-brand"
            />
            <span className="text-xs text-gray-600 leading-relaxed">
              J'ai lu le document et j'accepte de le signer électroniquement. Je reconnais que cette
              signature a la même valeur qu'une signature manuscrite et que mon identité, mon adresse IP
              et la date sont enregistrées dans le journal de preuve.
            </span>
          </label>

          <span className="block min-h-[1rem] text-[11px] text-danger-dark" role="alert">
            {error}
          </span>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 bg-gray-50 border-t border-gray-100">
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="px-4 py-2 text-sm font-semibold text-gray-600 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors"
          >
            Annuler
          </button>
          <button
            type="submit"
            disabled={!canConfirm}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
            style={{ backgroundColor: accentHex }}
          >
            {confirming && <Loader2 className="w-4 h-4 animate-spin" />}
            Signer
          </button>
        </div>

        <style>{`
          @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
          @keyframes scaleIn {
            from { opacity: 0; transform: scale(0.94); }
            to   { opacity: 1; transform: scale(1); }
          }
        `}</style>
      </form>
    </div>
  );
}
