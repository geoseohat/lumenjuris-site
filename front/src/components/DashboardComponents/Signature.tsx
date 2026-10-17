import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import toast, { Toaster } from "react-hot-toast";
import { CheckCircle2, X } from "lucide-react";
import { SignatureDashboard } from "./signature/SignatureDashboard";
import { SignatureWizard } from "./signature/SignatureWizard";

/**
 * Durée d'affichage de la confirmation d'envoi (10 s). Bien plus long qu'un
 * toast ordinaire : celui-ci accompagne un changement d'écran, il faut le temps
 * de le remarquer puis de lire le destinataire pour vérifier qu'on n'a pas
 * envoyé au mauvais contact. Il reste refermable d'un clic pour ceux qui ont
 * déjà lu.
 */
const SENT_TOAST_DURATION_MS = 10_000;

/**
 * Point d'entrée du module Signature (route `/signature`).
 *
 * "Nouveau contrat" ouvre directement le sélecteur de fichier OS.
 * Dès qu'un PDF est choisi, le wizard remplace le dashboard dans la page
 * (même comportement qu'avant, sans popup ni overlay).
 *
 * Après un envoi réussi, le wizard est démonté immédiatement : la confirmation
 * se fait donc ici, par un toast affiché par-dessus le tableau de bord
 * fraîchement rafraîchi — sinon l'utilisateur revient à la liste sans savoir si
 * son envoi est bien parti.
 */
export function Signature() {
  const location = useLocation();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Document arrivant directement d'un autre module (ex. générateur de CDD) :
  // un PDF est passé en data-URI dans l'état de navigation → ouvre le wizard.
  useEffect(() => {
    const state = location.state as
      | { incomingPdf?: string; incomingName?: string }
      | null;
    if (!state?.incomingPdf) return;
    let cancelled = false;
    fetch(state.incomingPdf)
      .then((r) => r.blob())
      .then((blob) => {
        if (cancelled) return;
        setSelectedFile(
          new File([blob], state.incomingName || "contrat.pdf", {
            type: "application/pdf",
          }),
        );
      })
      .catch(() => {});
    // Nettoie l'état pour éviter de rouvrir le wizard au prochain rendu.
    navigate(location.pathname, { replace: true, state: null });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (f) setSelectedFile(f);
    e.target.value = "";
  }

  function closeWizard() {
    setRefreshKey((k) => k + 1);
    setSelectedFile(null);
  }

  /**
   * Retour au tableau de bord après un envoi réussi, avec confirmation.
   * L'`id` fixe évite deux toasts empilés si l'envoi part deux fois.
   */
  function handleSent(recipient: { name: string; email: string; invitationSent: boolean }) {
    closeWizard();
    // Signature de l'émetteur enregistrée, mais l'e-mail n'est pas parti :
    // l'utilisateur doit pouvoir relancer depuis le tableau de bord.
    if (!recipient.invitationSent) {
      toast.error(
        "Votre signature est enregistrée, mais l'invitation n'a pas pu être envoyée. Utilisez « Renvoyer » dans le tableau.",
        { id: "signature-envoi-echoue", duration: SENT_TOAST_DURATION_MS },
      );
      return;
    }
    toast.custom(
      (t) => (
        <SentToast
          visible={t.visible}
          recipientName={recipient.name}
          recipientEmail={recipient.email}
          onClose={() => toast.dismiss(t.id)}
        />
      ),
      { id: "signature-envoyee", duration: SENT_TOAST_DURATION_MS },
    );
  }

  return (
    <>
      <Toaster position="top-right" />

      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={handleFileChosen}
      />

      {selectedFile ? (
        <SignatureWizard
          initialFile={selectedFile}
          onSent={handleSent}
          onExit={closeWizard}
        />
      ) : (
        <SignatureDashboard
          refreshKey={refreshKey}
          onNewContract={() => fileInputRef.current?.click()}
        />
      )}
    </>
  );
}

/**
 * Confirmation d'envoi affichée en haut à droite du tableau de bord.
 *
 * Toast maison plutôt que `toast.success` : il doit reprendre les styles
 * LumenJuris et, surtout, porter une croix de fermeture — un bandeau qui reste
 * 10 secondes sans pouvoir être écarté est vite pénible.
 */
function SentToast({
  visible, recipientName, recipientEmail, onClose,
}: {
  visible: boolean;
  recipientName: string;
  recipientEmail: string;
  onClose: () => void;
}) {
  return (
    <div
      className={`flex items-start gap-3 w-[22rem] max-w-[calc(100vw-2rem)] bg-white rounded-card border border-line shadow-card-md px-4 py-3 transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-2"
      }`}
      role="status"
    >
      <div className="w-8 h-8 rounded-panel bg-success-light flex items-center justify-center shrink-0">
        <CheckCircle2 className="w-4 h-4 text-success" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">Contrat envoyé pour signature</p>
        <p className="text-xs text-ink-muted leading-snug mt-0.5 break-words">
          <span className="font-medium text-ink-secondary">{recipientName}</span>{" "}
          ({recipientEmail}) va recevoir un e-mail l'invitant à signer. <br/>Vous recevrez une notification par email dés la signature de l'autre partie.
        </p>
      </div>

      <button
        onClick={onClose}
        aria-label="Fermer la notification"
        className="p-1 -m-1 rounded-lg text-ink-subtle hover:text-ink hover:bg-surface-subtle transition-colors shrink-0"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
