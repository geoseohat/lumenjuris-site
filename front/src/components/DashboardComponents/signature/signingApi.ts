/** Appels HTTP du parcours de signature (codes OTP, validation, refus). */

/** Réponse des routes OTP du back (envoi du code / validation de la signature). */
export interface OtpApiResult {
  success: boolean;
  message?: string;
  /** Code d'erreur métier, ex : "OTP_WRONG_CODE", "TOO_SOON". */
  code?: string;
  attemptsLeft?: number;
  retryAfterSeconds?: number;
}

/**
 * Appel POST JSON vers le proxy, converti en `OtpApiResult`.
 * Les erreurs métier du back arrivent avec un statut 4xx et un `code`.
 */
export async function postSigningRequest(
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  body: unknown = {},
): Promise<OtpApiResult & { data?: unknown; invitationSent?: boolean; status: number }> {
  const res = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as OtpApiResult & { data?: unknown; invitationSent?: boolean };
  return { ...json, success: res.ok && !!json.success, status: res.status };
}
