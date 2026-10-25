# -*- coding: utf-8 -*-
"""Envoi des pages de www.lumenjuris.com à l'API Indexing de Google.

Lit le plan du site (sitemap Rank Math), compare avec les adresses déjà
envoyées et signale à Google uniquement les pages nouvelles ou modifiées
(date « lastmod » changée).

Usage :
  python indexation_google.py            -> envoie les pages nouvelles ou modifiées
  python indexation_google.py --essai    -> montre ce qui serait envoyé, sans rien envoyer
  python indexation_google.py --tout     -> renvoie toutes les pages du plan du site

Fichiers :
  wordpress-vitrine/indexation-google/etat.json    adresse -> lastmod déjà envoyé
  wordpress-vitrine/indexation-google/journal.txt  une ligne par exécution
Clé du robot Google : jamais dans le dépôt.
  Routine cloud : variable GOOGLE_INDEXING_CLE_B64 (le fichier JSON encodé en base64).
  Sur le PC : C:\\Users\\geoff\\secrets\\google-indexing-lumenjuris.json
  (variable GOOGLE_INDEXING_CLE pour un autre emplacement).
"""
import base64
import json
import os
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

SITE = "https://www.lumenjuris.com"
SITEMAP = f"{SITE}/sitemap_index.xml"
DOSSIER = Path(__file__).resolve().parents[1] / "indexation-google"
ETAT = DOSSIER / "etat.json"
JOURNAL = DOSSIER / "journal.txt"
CLE = Path(os.environ.get("GOOGLE_INDEXING_CLE")
           or r"C:\Users\geoff\secrets\google-indexing-lumenjuris.json")
API = "https://indexing.googleapis.com/v3/urlNotifications:publish"
METADONNEES = "https://indexing.googleapis.com/v3/urlNotifications/metadata"
# Google accepte 200 envois par jour pour ce projet.
QUOTA_JOUR = 200
# La protection o2switch refuse les robots sans nom de navigateur.
AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LumenJuris-indexation"


def lire(url):
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def pages_du_sitemap():
    """Renvoie {adresse: lastmod} pour toutes les pages des sous-sitemaps."""
    pages = {}
    for sous in re.findall(r"<loc>([^<]+)</loc>", lire(SITEMAP)):
        for bloc in re.findall(r"<url>(.*?)</url>", lire(sous), re.S):
            loc = re.search(r"<loc>([^<]+)</loc>", bloc)
            mod = re.search(r"<lastmod>([^<]+)</lastmod>", bloc)
            if loc:
                pages[loc.group(1).strip()] = mod.group(1).strip() if mod else ""
    return pages


def charger_etat():
    return json.loads(ETAT.read_text(encoding="utf-8")) if ETAT.exists() else {}


def noter(ligne):
    DOSSIER.mkdir(exist_ok=True)
    with JOURNAL.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M} | {ligne}\n")
    print(ligne)


def ouvrir_session():
    scopes = ["https://www.googleapis.com/auth/indexing"]
    if os.environ.get("GOOGLE_INDEXING_CLE_B64"):
        # Routine cloud : la clé est rangée dans les variables de l'environnement.
        info = json.loads(base64.b64decode(os.environ["GOOGLE_INDEXING_CLE_B64"]))
        cred = service_account.Credentials.from_service_account_info(info, scopes=scopes)
    else:
        cred = service_account.Credentials.from_service_account_file(str(CLE), scopes=scopes)
    return AuthorizedSession(cred)


def main():
    essai = "--essai" in sys.argv
    tout = "--tout" in sys.argv
    pages = pages_du_sitemap()
    etat = charger_etat()
    a_envoyer = [u for u, mod in pages.items() if tout or etat.get(u) != mod]
    print(f"{len(pages)} pages dans le plan du site, {len(a_envoyer)} à envoyer.")
    if essai:
        for u in a_envoyer:
            print("  ", u)
        return
    session = ouvrir_session()
    if not a_envoyer:
        # Lecture de la fiche Google de l'accueil : prouve que la clé et l'accès
        # marchent, sans consommer le quota d'envois.
        r = session.get(METADONNEES, params={"url": f"{SITE}/"}, timeout=30)
        acces = "accès Google OK" if r.status_code in (200, 404) else f"accès Google en ERREUR {r.status_code}"
        noter(f"rien à envoyer ({len(pages)} pages, toutes déjà envoyées) ; {acces}")
        sys.exit(0 if r.status_code in (200, 404) else 1)

    ok, erreurs = [], []
    for u in a_envoyer[:QUOTA_JOUR]:
        r = session.post(API, json={"url": u, "type": "URL_UPDATED"}, timeout=30)
        if r.status_code == 200:
            ok.append(u)
            etat[u] = pages[u]
        else:
            try:
                message = r.json().get("error", {}).get("message", r.text)[:200]
            except ValueError:
                message = r.text[:200]
            erreurs.append(f"{u} -> {r.status_code} {message}")
            # Quota dépassé ou accès refusé : inutile d'insister sur les suivantes.
            if r.status_code in (403, 429):
                break
    DOSSIER.mkdir(exist_ok=True)
    ETAT.write_text(json.dumps(etat, ensure_ascii=False, indent=2), encoding="utf-8")

    reste = len(a_envoyer) - len(ok)
    ligne = f"{len(ok)} page(s) envoyée(s) à Google, {len(erreurs)} erreur(s), {reste} en attente"
    if erreurs:
        ligne += " ; " + " ; ".join(erreurs[:3])
    noter(ligne)
    sys.exit(1 if erreurs else 0)


if __name__ == "__main__":
    main()
