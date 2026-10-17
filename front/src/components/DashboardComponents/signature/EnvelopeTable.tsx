import { useMemo, useState } from "react";
import { Archive, CheckCircle2, Download, FileArchive, FileText, Loader2, MailPlus, PenLine } from "lucide-react";

import { DataTable, EmptyCell, type DataTableColumn } from "../../common/DataTable";
import { RowActionsMenu, type RowAction } from "../../common/RowActionsMenu";

/** Statuts d'enveloppe (miroir de l'enum Prisma). */
export type EnvelopeStatus = "DRAFT" | "SENT" | "PARTIALLY_SIGNED" | "SIGNED" | "DECLINED" | "EXPIRED" | "ARCHIVED";

export interface EnvelopeDTO {
  id: string;
  documentName: string;
  numPages: number;
  status: EnvelopeStatus;
  selfName: string;
  selfEmail: string;
  counterpartyName: string;
  counterpartyEmail: string;
  sentAt: string | null;
  selfSignedAt: string | null;
  counterpartySignedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Vrai si le dossier de preuve existe (enveloppes signées avec le journal). */
  hasEvidence: boolean;
}

/** État d'une relance déclenchée depuis le tableau. */
export type ResendState = "idle" | "sending" | "done" | "error";

type SortKey = "documentName" | "counterpartyName" | "status" | "sentAt" | "completedAt" | "createdAt";
type SortDirection = "asc" | "desc";

interface Props {
  items: EnvelopeDTO[];
  loading: boolean;
  onArchive: (id: string) => void;
  onResend: (envelope: EnvelopeDTO) => void;
  /** Brouillon : l'émetteur n'a pas encore confirmé sa signature par code. */
  onConfirmSignature: (envelope: EnvelopeDTO) => void;
  onDownloadSignedPdf: (envelope: EnvelopeDTO) => void;
  onDownloadEvidence: (envelope: EnvelopeDTO) => void;
  resendStates: Record<string, ResendState>;
}

const STORAGE_KEY = "signature_table_visible_columns";
const DEFAULT_COLUMNS = ["documentName", "counterpartyName", "status", "sentAt", "waiting", "action"];

/** Ordre logique des statuts pour le tri (du brouillon à la fin du cycle). */
const STATUS_ORDER: EnvelopeStatus[] = ["DRAFT", "SENT", "PARTIALLY_SIGNED", "SIGNED", "DECLINED", "EXPIRED", "ARCHIVED"];

const STATUS_CONFIG: Record<EnvelopeStatus, { label: string; bg: string; fg: string }> = {
  DRAFT:             { label: "Brouillon",      bg: "#f1f5f9", fg: "#64748b" },
  SENT:              { label: "Envoyé",         bg: "#fef3c7", fg: "#92400e" },
  PARTIALLY_SIGNED:  { label: "Partiellement",  bg: "#dbeafe", fg: "#1e40af" },
  SIGNED:            { label: "Signé",          bg: "#d1fae5", fg: "#065f46" },
  DECLINED:          { label: "Refusé",         bg: "#fee2e2", fg: "#991b1b" },
  EXPIRED:           { label: "Expiré",         bg: "#f3f4f6", fg: "#6b7280" },
  ARCHIVED:          { label: "Archivé",        bg: "#eaecf2", fg: "#374151" },
};

/** Au-delà de cette attente, le badge passe en orange : il est temps de relancer. */
const RELANCE_AFTER_DAYS = 7;

/** Vrai quand l'enveloppe attend encore la signature du cocontractant. */
function isPending(status: EnvelopeStatus): boolean {
  return status === "SENT" || status === "PARTIALLY_SIGNED" || status === "EXPIRED";
}

/** Nombre de jours entiers écoulés depuis une date ISO (null si absente). */
function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const elapsedMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(elapsedMs) || elapsedMs < 0) return null;
  return Math.floor(elapsedMs / (1000 * 60 * 60 * 24));
}

/** "JJ/MM/AAAA" à partir d'une date ISO (null si absente). */
function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Date ISO → nombre pour le tri (les dates absentes sont placées en dernier). */
function dateToSortValue(iso: string | null, sortDirection: SortDirection): number {
  if (!iso) return sortDirection === "asc" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return new Date(iso).getTime();
}

/** Trie les enveloppes sans modifier le tableau d'origine. */
function sortEnvelopes(items: EnvelopeDTO[], sortBy: SortKey, sortDirection: SortDirection): EnvelopeDTO[] {
  return [...items].sort((a, b) => {
    let comparison: number;
    if (sortBy === "documentName" || sortBy === "counterpartyName") {
      comparison = a[sortBy].localeCompare(b[sortBy], "fr", { sensitivity: "base" });
    } else if (sortBy === "status") {
      comparison = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    } else if (sortBy === "createdAt") {
      comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    } else {
      comparison = dateToSortValue(a[sortBy], sortDirection) - dateToSortValue(b[sortBy], sortDirection);
    }
    return sortDirection === "asc" ? comparison : -comparison;
  });
}

/** Tableau des enveloppes de signature. */
export function EnvelopeTable({
  items, loading, onArchive, onResend, onConfirmSignature, onDownloadSignedPdf, onDownloadEvidence, resendStates,
}: Props) {
  const [sortBy, setSortBy] = useState<SortKey>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const sortedItems = useMemo(
    () => sortEnvelopes(items, sortBy, sortDirection),
    [items, sortBy, sortDirection],
  );

  const handleSort = (key: SortKey) => {
    if (key === sortBy) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(key);
      // Textes : A → Z d'abord ; statuts et dates : l'ordre le plus parlant d'abord.
      setSortDirection(key === "documentName" || key === "counterpartyName" ? "asc" : "desc");
    }
  };

  /** Actions du menu « ⋮ » d'une enveloppe (la relance dépend de son état). */
  const buildActions = (envelope: EnvelopeDTO): RowAction[] => {
    const actions: RowAction[] = [];
    const resendState = resendStates[envelope.id] ?? "idle";

    // Brouillon : la signature de l'émetteur attend encore son code de confirmation.
    if (envelope.status === "DRAFT") {
      actions.push({
        label: "Confirmer ma signature",
        icon: <PenLine className="h-3.5 w-3.5" />,
        onSelect: () => onConfirmSignature(envelope),
      });
    }

    // Signé par les deux parties : contrat signé et dossier de preuve.
    if (envelope.status === "SIGNED") {
      actions.push({
        label: "Télécharger le contrat signé",
        icon: <Download className="h-3.5 w-3.5" />,
        onSelect: () => onDownloadSignedPdf(envelope),
      });
      if (envelope.hasEvidence) {
        actions.push({
          label: "Télécharger le dossier de preuve",
          icon: <FileArchive className="h-3.5 w-3.5" />,
          onSelect: () => onDownloadEvidence(envelope),
        });
      }
    }

    // Relance : uniquement pour les enveloppes qui attendent encore une signature.
    if (isPending(envelope.status)) {
      let label = "Relancer";
      if (resendState === "sending") label = "Relance en cours…";
      if (resendState === "done") label = "Relance envoyée";

      let icon = <MailPlus className="h-3.5 w-3.5" />;
      if (resendState === "sending") icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      if (resendState === "done") icon = <CheckCircle2 className="h-3.5 w-3.5 text-success-dark" />;

      actions.push({
        label,
        icon,
        disabled: resendState === "sending" || resendState === "done",
        onSelect: () => onResend(envelope),
      });
    }

    // Plus de suppression : l'enveloppe et sa preuve sont conservées.
    if (envelope.status !== "ARCHIVED") {
      actions.push({
        label: "Archiver",
        icon: <Archive className="h-3.5 w-3.5" />,
        onSelect: () => onArchive(envelope.id),
      });
    }

    return actions;
  };

  const columns: DataTableColumn<EnvelopeDTO, SortKey>[] = [
    {
      id: "documentName",
      label: "Document",
      sortKey: "documentName",
      cell: (envelope) => (
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0 rounded-xl bg-brand-light p-2 text-blue-primary transition-colors group-hover:bg-blue-primary group-hover:text-white">
            <FileText className="h-4 w-4" />
          </div>
          <span
            title={envelope.documentName}
            className="max-w-[220px] truncate font-medium text-ink transition-colors group-hover:text-blue-primary"
          >
            {envelope.documentName}
          </span>
        </div>
      ),
    },
    {
      id: "counterpartyName",
      label: "Cocontractant",
      sortKey: "counterpartyName",
      cellClassName: "text-xs text-ink-secondary",
      cell: (envelope) => envelope.counterpartyName || <EmptyCell />,
    },
    {
      id: "counterpartyEmail",
      label: "E-mail",
      cellClassName: "text-xs text-ink-muted",
      cell: (envelope) =>
        envelope.counterpartyEmail ? (
          <span title={envelope.counterpartyEmail} className="block max-w-[200px] truncate">
            {envelope.counterpartyEmail}
          </span>
        ) : (
          <EmptyCell />
        ),
    },
    {
      id: "status",
      label: "Statut",
      sortKey: "status",
      cell: (envelope) => <StatusBadge status={envelope.status} />,
    },
    {
      id: "sentAt",
      label: "Envoyé le",
      sortKey: "sentAt",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => formatDate(envelope.sentAt) ?? <EmptyCell />,
    },
    {
      id: "waiting",
      label: "Attente",
      cellClassName: "whitespace-nowrap",
      // Une attente qui s'allonge est le signal qui justifie une relance.
      cell: (envelope) => {
        const waitingDays = isPending(envelope.status)
          ? daysSince(envelope.sentAt ?? envelope.createdAt)
          : null;
        if (waitingDays === null) return <EmptyCell />;

        return (
          <span
            title={`En attente de signature depuis ${waitingDays} jour${waitingDays > 1 ? "s" : ""}`}
            className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${
              waitingDays >= RELANCE_AFTER_DAYS
                ? "border-amber-200/80 bg-amber-50 text-amber-700"
                : "border-line bg-surface-subtle text-ink-secondary"
            }`}
          >
            {waitingDays} j
          </span>
        );
      },
    },
    {
      id: "selfSignedAt",
      label: "Ma signature",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => formatDate(envelope.selfSignedAt) ?? <EmptyCell />,
    },
    {
      id: "counterpartySignedAt",
      label: "Signature cocontractant",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => formatDate(envelope.counterpartySignedAt) ?? <EmptyCell />,
    },
    {
      id: "completedAt",
      label: "Finalisé le",
      sortKey: "completedAt",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => formatDate(envelope.completedAt) ?? <EmptyCell />,
    },
    {
      id: "numPages",
      label: "Pages",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => envelope.numPages,
    },
    {
      id: "createdAt",
      label: "Créé le",
      sortKey: "createdAt",
      cellClassName: "whitespace-nowrap text-xs text-ink-muted",
      cell: (envelope) => formatDate(envelope.createdAt) ?? <EmptyCell />,
    },
    {
      id: "action",
      label: "Action",
      alignRight: true,
      cell: (envelope) => (
        <div className="inline-flex items-center justify-end gap-2">
          <ResendIndicator state={resendStates[envelope.id] ?? "idle"} />
          <RowActionsMenu actions={buildActions(envelope)} />
        </div>
      ),
    },
  ];

  const countLabel = `${items.length} enveloppe${items.length > 1 ? "s" : ""}`;

  return (
    <DataTable
      items={sortedItems}
      loading={loading}
      rowKey={(envelope) => envelope.id}
      columns={columns}
      defaultColumns={DEFAULT_COLUMNS}
      storageKey={STORAGE_KEY}
      sortBy={sortBy}
      sortDir={sortDirection}
      onSort={handleSort}
      empty={{
        title: "Aucune enveloppe",
        description: "Envoyez un document en signature pour le suivre ici.",
      }}
      summary={loading ? null : countLabel}
    />
  );
}

/** Badge coloré selon le statut de l'enveloppe. */
function StatusBadge({ status }: { status: EnvelopeStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-chip px-2 py-0.5 text-[10px] font-semibold"
      style={{ backgroundColor: config.bg, color: config.fg }}
    >
      {config.label}
    </span>
  );
}

/** Petit indicateur à côté du menu : relance en cours (chargement) ou envoyée (coche). */
function ResendIndicator({ state }: { state: ResendState }) {
  if (state === "sending") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-subtle" aria-label="Relance en cours" />;
  }
  if (state === "done") {
    return (
      <span title="Relance envoyée" className="inline-flex">
        <CheckCircle2 className="h-3.5 w-3.5 text-success-dark" aria-label="Relance envoyée" />
      </span>
    );
  }
  return null;
}
