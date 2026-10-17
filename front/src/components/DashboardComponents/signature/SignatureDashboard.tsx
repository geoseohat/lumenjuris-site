import { useEffect, useState, useCallback } from "react";
import { Plus, FileText, Send, Clock, CheckCircle2, AlertCircle, Filter } from "lucide-react";
import { fetchProxy } from "../../../utils/fetchProxy";
import { ConfirmationModal } from "../../ui/ConfirmationModal";
import { EnvelopeTable } from "./EnvelopeTable";
import { SigningOtpModal } from "./SigningOtpModal";
import { postSigningRequest } from "./signingApi";
import type { EnvelopeDTO, EnvelopeStatus, ResendState } from "./EnvelopeTable";
import { BannerAction, PageBanner } from "../../common/PageBanner";

interface Stats {
  total: number;
  draft: number;
  sent: number;
  partiallySigned: number;
  signed: number;
  other: number;
  recent: EnvelopeDTO[];
}

interface Props {
  /** Appelé quand l'utilisateur clique sur "Nouveau contrat". */
  onNewContract: () => void;
  /** Clé de refresh — incrémenter pour forcer un re-fetch des données. */
  refreshKey?: number;
}

/**
 * Vue tableau de bord du module Signature électronique :
 *   - 4 cartes KPI (total / signés / en cours / brouillons)
 *   - filtre par statut
 *   - tableau des enveloppes (colonnes au choix, tri)
 *   - bouton "Nouveau contrat" en haut à droite
 *
 * Charge les données via 2 endpoints proxy :
 *   GET /api/signature-envelope/stats  → KPIs + 5 récents
 *   GET /api/signature-envelope?status=XXX → liste filtrée
 */
export function SignatureDashboard({ onNewContract, refreshKey }: Props) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [list, setList] = useState<EnvelopeDTO[]>([]);
  const [filter, setFilter] = useState<EnvelopeStatus | "ALL">("ALL");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [validateModalOpen, setValidateModalOpen] = useState(false);
  const [pendingArchiveId, setPendingArchiveId] = useState<string | null>(null);
  // Brouillon dont l'émetteur confirme sa signature par code depuis le tableau.
  const [envelopeToConfirm, setEnvelopeToConfirm] = useState<EnvelopeDTO | null>(null);
  // Relance : enveloppe en attente de confirmation + état par enveloppe.
  // Une relance envoie un e-mail : elle passe toujours par une confirmation.
  const [pendingResend, setPendingResend] = useState<EnvelopeDTO | null>(null);
  const [resendStates, setResendStates] = useState<Record<string, ResendState>>({});

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [statsRes, listRes] = await Promise.all([
        fetchProxy("/api/signature-envelope/stats", { credentials: "include" }),
        fetchProxy(`/api/signature-envelope${filter !== "ALL" ? `?status=${filter}` : ""}`, { credentials: "include" }),
      ]);
      const statsData = await statsRes.json() as { success: boolean; data?: Stats };
      const listData = await listRes.json() as { success: boolean; data?: EnvelopeDTO[] };
      if (statsData.success && statsData.data) setStats(statsData.data);
      if (listData.success && listData.data) setList(listData.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Erreur réseau");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { void fetchAll(); }, [fetchAll, refreshKey]);


  function handleArchive(externalId: string) {
    setPendingArchiveId(externalId);
    setValidateModalOpen(true);
  }

  async function archiveConfirmed() {
    if (!pendingArchiveId) return;
    try {
      await fetchProxy(`/api/signature-envelope/${pendingArchiveId}`, {
        method: "DELETE",
        credentials: "include",
      });
      await fetchAll();
    } catch { /* silent */ }
    finally {
      setValidateModalOpen(false);
      setPendingArchiveId(null);
    }
  }

  /**
   * Télécharge un fichier renvoyé par le back (PDF signé ou ZIP de preuve).
   * Le nom vient de l'en-tête Content-Disposition, sinon du nom proposé.
   */
  async function downloadFile(url: string, fallbackFileName: string) {
    setError("");
    try {
      const res = await fetchProxy(url, { credentials: "include" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { message?: string };
        throw new Error(data.message ?? "Le téléchargement a échoué.");
      }
      const disposition = res.headers.get("content-disposition") ?? "";
      const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackFileName;
      const blobUrl = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      // Le lien doit être dans le document et l'URL libérée après coup :
      // certains navigateurs annulent le téléchargement sinon.
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Le téléchargement a échoué.");
    }
  }

  function handleDownloadSignedPdf(envelope: EnvelopeDTO) {
    const baseName = envelope.documentName.replace(/\.pdf$/i, "");
    void downloadFile(`/api/signature-envelope/download/${envelope.id}`, `${baseName}_signe.pdf`);
  }

  function handleDownloadEvidence(envelope: EnvelopeDTO) {
    const baseName = envelope.documentName.replace(/\.pdf$/i, "");
    void downloadFile(`/api/signature-envelope/evidence/${envelope.id}`, `${baseName}_dossier_de_preuve.zip`);
  }

  /** Valide la signature d'un brouillon avec le code : l'invitation part alors. */
  async function confirmDraftSignature(code: string) {
    const result = await postSigningRequest(
      fetchProxy,
      `/api/signature-envelope/${envelopeToConfirm?.id}/sign`,
      { code, consentAccepted: true },
    );
    if (result.success) {
      setEnvelopeToConfirm(null);
      if (result.invitationSent === false) {
        setError("Votre signature est enregistrée, mais l'invitation n'a pas pu être envoyée. Utilisez « Relancer ».");
      }
      await fetchAll();
    }
    return result;
  }

  /** Ouvre la confirmation de relance pour une enveloppe. */
  function handleResend(envelope: EnvelopeDTO) {
    setPendingResend(envelope);
  }

  /** Renvoie l'e-mail d'invitation à signer, après confirmation. */
  async function resendConfirmed() {
    const envelope = pendingResend;
    setPendingResend(null);
    if (!envelope) return;
    setResendStates((prev) => ({ ...prev, [envelope.id]: "sending" }));
    try {
      const res = await fetchProxy("/api/signature-envelope/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ externalId: envelope.id }),
      });
      const data = await res.json() as { success?: boolean; message?: string };
      if (!res.ok || !data.success) throw new Error(data.message ?? "Échec de la relance.");
      setResendStates((prev) => ({ ...prev, [envelope.id]: "done" }));
    } catch (e: unknown) {
      setResendStates((prev) => ({ ...prev, [envelope.id]: "error" }));
      setError(e instanceof Error ? e.message : "Échec de la relance.");
    }
  }

  return (
    <div className="space-y-5 mx-auto w-full max-w-7xl">
      <Header onNewContract={onNewContract} />

      {error && (
        <div className="flex items-center gap-2 text-sm text-danger-dark bg-danger-light border border-danger/20 px-4 py-3 rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Total"
          value={stats?.total ?? 0}
          icon={FileText}
          accent="#354F99"
          loading={loading}
        />
        <KpiCard
          label="En attente"
          value={(stats?.sent ?? 0) + (stats?.partiallySigned ?? 0)}
          icon={Clock}
          accent="#d97706"
          loading={loading}
        />
        <KpiCard
          label="Signés"
          value={stats?.signed ?? 0}
          icon={CheckCircle2}
          accent="#059669"
          loading={loading}
        />
        <KpiCard
          label="Brouillons"
          value={stats?.draft ?? 0}
          icon={Send}
          accent="#64748b"
          loading={loading}
        />
      </div>

      {/* Filtres */}
      <StatusFilters current={filter} onChange={setFilter} />

      {/* Tableau des enveloppes */}
      <EnvelopeTable
        items={list}
        loading={loading}
        onArchive={handleArchive}
        onResend={handleResend}
        onConfirmSignature={setEnvelopeToConfirm}
        onDownloadSignedPdf={handleDownloadSignedPdf}
        onDownloadEvidence={handleDownloadEvidence}
        resendStates={resendStates}
      />
        <ConfirmationModal
          open={validateModalOpen}
          title="Archiver l'enveloppe"
          description="L'enveloppe disparaîtra de la liste (filtre « Archivés » pour la retrouver). Le document et son journal de preuve restent conservés."
          confirmLabel="Archiver"
          onConfirm={archiveConfirmed}
          onCancel={() => { setValidateModalOpen(false); setPendingArchiveId(null); }}
        />
        <SigningOtpModal
          open={!!envelopeToConfirm}
          recipientEmail={envelopeToConfirm?.selfEmail}
          documentName={envelopeToConfirm?.documentName ?? ""}
          accentHex="#2C3A5E"
          onRequestCode={() => postSigningRequest(fetchProxy, `/api/signature-envelope/${envelopeToConfirm?.id}/otp`)}
          onConfirm={confirmDraftSignature}
          onClose={() => setEnvelopeToConfirm(null)}
        />
        <ConfirmationModal
          open={!!pendingResend}
          title="Relancer la signature"
          description={pendingResend
            ? `Un nouvel e-mail d'invitation à signer va être envoyé à ${pendingResend.counterpartyName} (${pendingResend.counterpartyEmail}). Le lien de signature reste le même.`
            : ""}
          confirmLabel="Envoyer la relance"
          onConfirm={() => void resendConfirmed()}
          onCancel={() => setPendingResend(null)}
        />
    </div>
  );
}

// ─── Sous-composants ──────────────────────────────────────────────────────────

/** Titre de la page + bouton "Nouveau contrat". */
function Header({ onNewContract }: { onNewContract: () => void }) {
  return (
    <PageBanner
      title="Signature électronique"
      subtitle="Suivez l'avancement de vos contrats à signer."
      actions={
        <BannerAction onClick={onNewContract} icon={<Plus />}>
          Envoyer pour signature
        </BannerAction>
      }
    />
  );
}

/** Une carte KPI — même gabarit que la bibliothèque de clauses (icône à gauche). */
function KpiCard({
  label, value, icon: Icon, accent, loading,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  accent: string;
  loading?: boolean;
}) {
  return (
    <div className="bg-white rounded-card border border-line shadow-card p-3 sm:p-4 flex items-center gap-3 sm:gap-4">
      <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-panel flex items-center justify-center shrink-0" style={{ backgroundColor: accent + "18" }}>
        <Icon className="w-5 h-5 stroke-[1.5]" style={{ color: accent }} />
      </div>
      <div className="min-w-0">
        {loading ? (
          <div className="h-7 w-8 rounded-md bg-surface-muted animate-pulse mb-1" />
        ) : (
          <p className="text-xl sm:text-2xl font-bold tracking-tight text-ink">{value}</p>
        )}
        <p className="text-[10px] font-semibold text-ink-subtle uppercase tracking-widest leading-tight mt-0.5">{label}</p>
      </div>
    </div>
  );
}

/** Boutons de filtre par statut. */
function StatusFilters({
  current, onChange,
}: {
  current: EnvelopeStatus | "ALL";
  onChange: (s: EnvelopeStatus | "ALL") => void;
}) {
  const options: Array<{ id: EnvelopeStatus | "ALL"; label: string }> = [
    { id: "ALL", label: "Tous" },
    { id: "SENT", label: "Envoyés" },
    { id: "PARTIALLY_SIGNED", label: "Partiellement signés" },
    { id: "SIGNED", label: "Signés" },
    { id: "DRAFT", label: "Brouillons" },
    { id: "DECLINED", label: "Refusés" },
    { id: "EXPIRED", label: "Expirés" },
    { id: "ARCHIVED", label: "Archivés" },
  ];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Filter className="w-3.5 h-3.5 text-ink-subtle" />
      {options.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all shadow-card ${
            current === o.id
              ? "bg-brand text-white border-brand"
              : "text-ink-secondary bg-white border-line hover:bg-surface-subtle"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
