# -*- coding: utf-8 -*-
"""Contrôle qualité d'une page « Modèle de contrat » avant publication.

Vérifie ce qu'une machine peut vérifier : structure, longueurs SEO, mots et
affirmations interdits, sources Légifrance, ressemblance avec les autres pages
(contenu dupliqué, que Google sanctionne au titre du « scaled content abuse »).
Liste aussi les articles de loi et les chiffres cités, à relire un par un : le
contrôle juridique de fond reste à faire (voir la compétence routine-modele-contrat).

Usage : python modeles_contrat.py controler <slug>
"""
import html
import json
import re
import unicodedata
from datetime import date
from pathlib import Path

# Textes dont l'identifiant Légifrance a été vérifié (23 oct. 2026).
TEXTES_VERIFIES = {
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006070721": "Code civil",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000005634379": "Code de commerce",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006072050": "Code du travail",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006069565": "Code de la consommation",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006069414": "Code de la propriété intellectuelle",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006072026": "Code monétaire et financier",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006069577": "Code général des impôts",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006073189": "Code de la sécurité sociale",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006070716": "Code de procédure civile",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006071191": "Code de l'éducation",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006074073": "Code du tourisme",
    "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006074096": "Code de la construction et de l'habitation",
    "https://www.legifrance.gouv.fr/loda/id/JORFTEXT000000509310": "Loi n° 89-462 du 6 juillet 1989 (baux d'habitation)",
    "https://www.legifrance.gouv.fr/loda/id/LEGITEXT000006068624": "Loi n° 78-17 du 6 janvier 1978 (informatique et libertés)",
    "https://eur-lex.europa.eu/eli/reg/2016/679/oj": "Règlement (UE) 2016/679 (RGPD)",
}
FORMES_SOURCES = (
    r"https://www\.legifrance\.gouv\.fr/codes/texte_lc/LEGITEXT\d{12}",
    r"https://www\.legifrance\.gouv\.fr/loda/id/(JORFTEXT|LEGITEXT)\d{12}",
    r"https://eur-lex\.europa\.eu/eli/(reg|dir)/\d{4}/\d+/oj",
)
CODES = ["Code civil", "Code de commerce", "Code du travail", "Code de la consommation",
         "Code de la propriété intellectuelle", "Code monétaire et financier", "Code général des impôts",
         "Code de la sécurité sociale", "Code de procédure civile", "Code de l'éducation", "Code du tourisme",
         "Code de la construction et de l'habitation", "Code pénal"]
IDS_RESERVES = {"modele", "etapes", "faq", "auteur", "associes"}
A_COMPLETER = "À COMPLÉTER"

# Motifs cherchés dans le texte sans accents et en minuscules, sur le texte éditorial
# (article, chapô, FAQ, étapes, titre, description) ; « avocat » est cherché partout.
INTERDITS = [
    (r"personnaliser en ligne", "le bouton s'appelle « Personnaliser », pas « Personnaliser en ligne »"),
    (r"selon (une|des|nos|notre) (etude|enquete|statistique|sondage|donnee)", "statistique invérifiable"),
    (r"\d ?% des (entreprises|francais|salaries|contrats|litiges|pme|dirigeants|createurs|personnes|cas|"
     r"proprietaires|locataires|freelances|independants|associes|startups?)", "statistique invérifiable"),
    (r"des (milliers|millions|centaines) d", "volume invérifiable (« des milliers de … »)"),
    (r"plus de [\d ]+ (clients|utilisateurs|entreprises|telechargements|modeles)", "chiffre commercial invérifiable"),
    (r"\bn ?° ?1 (des|du|de la|en)\b|numero un (des|du|de la|en)", "superlatif commercial invérifiable"),
    (r"100 ?% (conforme|legal|valable|securise|fiable)|conforme a 100|sans aucun risque|zero risque",
     "promesse absolue de conformité (interdite)"),
    (r"(garanti|garantie|garantis) (conforme|valable|sans risque|juridiquement)", "garantie juridique (interdite)"),
    (r"(detecte|repere|identifie|trouve)n?t? (toutes|tous) les (clauses|risques|erreurs|pieges|problemes|anomalies)",
     "promesse absolue sur l'analyse (aucun outil ne repère tout)"),
]
A_SURVEILLER = [
    (r"\b(le|la|les) meilleure?s?\b|\bleader\b", "superlatif : vérifiez qu'il ne s'agit pas d'une promesse commerciale"),
    (r"\btoujours (valable|conforme|legal)|\bjamais (conteste|annule)", "affirmation absolue à nuancer"),
]
# Affirmations de relecture humaine : interdites tant que relecture.valide = false.
RELECTURE = (r"(redige|relu|valide|verifie|approuve|controle|concu)e?s? par (un|une|des|notre|nos|l'|la|le) ?"
             r"(equipe juridique|juriste|expert|professionnel|specialiste)")


def sans_accents(s):
    s = unicodedata.normalize("NFKD", s.replace("’", "'").lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def mots(s):
    return re.findall(r"[a-z0-9]+", sans_accents(s))


def texte(h):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h))).strip()


def corpus(dossier):
    """Texte propre à une page : article, chapô, FAQ, étapes (le gabarit commun est exclu)."""
    f = json.loads((dossier / "fiche.json").read_text(encoding="utf-8"))
    morceaux = [texte((dossier / "article.html").read_text(encoding="utf-8")), f.get("chapo", "")]
    morceaux += [f"{q} {r}" for q, r in f.get("faq", [])] + [f"{n} {t}" for n, t in f.get("etapes", [])]
    return f, " ".join(morceaux)


def tuiles(liste, n=8):
    return {" ".join(liste[i:i + n]) for i in range(len(liste) - n + 1)}


def phrases_copiees(txt, autres_tuiles, n=8):
    copiees = []
    for ph in re.split(r"(?<=[.!?:])\s+", txt):
        t = tuiles(mots(ph), n)
        if len(t) >= 3 and len(t & autres_tuiles) / len(t) >= 0.6:
            copiees.append(ph[:140])
    return copiees


def articles_cites(s):
    motif = (r"\b(?:articles?|art\.)\s+((?:[LRDA]\.?\s?)?\d+(?:-\d+)*(?:\s*(?:,|et|à|a)\s*(?:[LRDA]\.?\s?)?\d+(?:-\d+)*)*)"
             r"(?:\s+(?:du|de la|de l'|des)\s+((?:Code|loi|règlement|décret)[^,.;:)\n]{0,60}))?")
    vus = []
    for m in re.finditer(motif, s):
        num = m.group(1).strip()
        # « article 26 des Statuts » renvoie au contrat lui-même, pas à la loi
        if not (m.group(2) or re.search(r"[LRDA]\.?\s?\d|\d-\d", num) or int(re.match(r"\d+", num.lstrip("LRDA. ")).group(0)) >= 100):
            continue
        c = f"art. {num}" + (f" – {m.group(2).strip()}" if m.group(2) else "")
        if c not in vus:
            vus.append(c)
    return vus


def chiffres(s):
    motif = r"\b\d[\d  .,]*\s?(?:%|euros?|€|jours?|mois|ans|années|heures|semaines|salariés|associés)(?![A-Za-zÀ-ÿ])"
    return sorted({m.group(0).strip() for m in re.finditer(motif, s)})


def controler(dossier, autres_dossiers, genre="modele"):
    """Renvoie (erreurs, avertissements, a_relire).
    genre « revue » : guide de revue contractuelle (grille.txt, bouton « Analyser »)."""
    err, av, relire = [], [], []
    revue = genre == "revue"
    nom_texte = "grille.txt" if revue else "modele.txt"
    f, propre = corpus(dossier)
    article = (dossier / "article.html").read_text(encoding="utf-8")
    modele = (dossier / nom_texte).read_text(encoding="utf-8")
    fiche_txt = (dossier / "fiche.json").read_text(encoding="utf-8")
    valide = bool(f.get("relecture", {}).get("valide"))

    # Restes du gabarit
    for nom, contenu in (("fiche.json", fiche_txt), ("article.html", article), (nom_texte, modele)):
        if A_COMPLETER in contenu or "TODO" in contenu:
            err.append(f"{nom} : il reste des « {A_COMPLETER} » ou « TODO »")

    # Fiche : champs, longueurs SEO
    for cle in ("slug", "nom", "nom_court", "categorie", "mot_cle", "mots_cles_secondaires", "titre_h1",
                "titre_seo", "meta_description", "chapo", "fichier_base", "date_publication",
                "date_mise_a_jour", "relecture", "etapes", "faq", "sources", "analyser" if revue else "personnaliser"):
        if cle not in f:
            err.append(f"fiche.json : champ « {cle} » manquant")
    ts, md = f.get("titre_seo", ""), f.get("meta_description", "")
    if len(ts) > 70:
        err.append(f"titre_seo trop long ({len(ts)} caractères, 65 conseillés) : Google le coupe")
    elif len(ts) > 65 or len(ts) < 30:
        av.append(f"titre_seo : {len(ts)} caractères (30 à 65 conseillés)")
    if len(md) > 160:
        err.append(f"meta_description trop longue ({len(md)} caractères, 160 au plus)")
    elif len(md) < 110:
        av.append(f"meta_description courte ({len(md)} caractères, 120 à 160 conseillés)")
    if not 120 <= len(f.get("chapo", "")) <= 450:
        av.append(f"chapô : {len(f.get('chapo', ''))} caractères (120 à 450 conseillés)")
    if not revue and not f.get("mot_cle", "").lower().startswith("modèle"):
        av.append("mot_cle : commence normalement par « modèle … »")
    annees = re.findall(r"\b20\d\d\b", ts)
    if annees and annees[0] != f.get("date_mise_a_jour", "")[:4]:
        av.append(f"titre_seo annonce {annees[0]} mais la page est mise à jour en {f.get('date_mise_a_jour', '')[:4]}")
    if len(f.get("etapes", [])) != 5:
        err.append(f"il faut exactement 5 étapes (il y en a {len(f.get('etapes', []))})")
    for n, t in f.get("etapes", []):
        if len(t) < 50:
            av.append(f"étape « {n} » : texte très court")
    nb_faq = len(f.get("faq", []))
    if not 6 <= nb_faq <= 8:
        err.append(f"il faut 6 à 8 questions de FAQ (il y en a {nb_faq})")
    for q, r in f.get("faq", []):
        if not q.strip().endswith("?"):
            av.append(f"FAQ : « {q[:60]} » ne se termine pas par « ? »")
        if not 120 <= len(r) <= 900:
            av.append(f"FAQ « {q[:50]} » : réponse de {len(r)} caractères (120 à 900 conseillés)")
    rel = f.get("relecture", {})
    if rel.get("valide") and not rel.get("date_validation"):
        err.append("relecture.valide = true sans date_validation")
    for cle in ("date_publication", "date_mise_a_jour"):
        try:
            if date.fromisoformat(f.get(cle, "")) > date.today():
                err.append(f"{cle} est dans le futur")
        except ValueError:
            err.append(f"{cle} : date invalide (format AAAA-MM-JJ)")

    # Sources
    sources = f.get("sources", [])
    if len(sources) < 2:
        err.append("il faut au moins 2 sources")
    for nom, url in sources:
        url_n = url.rstrip("/")
        if not any(re.fullmatch(fs, url_n) for fs in FORMES_SOURCES):
            err.append(f"source « {nom[:50]} » : lien refusé ({url}). Lien vers le texte entier "
                       "(LEGITEXT / JORFTEXT / EUR-Lex), jamais vers un article (LEGIARTI)")
        elif url_n not in TEXTES_VERIFIES:
            av.append(f"source « {nom[:50]} » : identifiant non vérifié ({url_n}), à confirmer avant publication")
    noms_sources = sans_accents(" ".join(n for n, _ in sources))
    tout = f"{modele} {texte(article)} {propre}"
    for code in CODES:
        if sans_accents(code) in sans_accents(tout) and sans_accents(code) not in noms_sources:
            av.append(f"le texte cite le {code} mais aucune source ne le mentionne")

    # Article : structure
    if "<table" not in article:
        err.append("article.html : au moins un tableau (<table>) est obligatoire")
    if re.search(r"<h1\b", article, re.I):
        err.append("article.html : pas de <h1> (le thème affiche déjà le titre)")
    ids = re.findall(r'<h2 id="([^"]+)"', article)
    if len(ids) < 5:
        err.append(f"article.html : {len(ids)} sections <h2 id=…> (5 au moins)")
    if len(set(ids)) != len(ids):
        err.append("article.html : deux sections ont le même id")
    if IDS_RESERVES & set(ids):
        err.append(f"article.html : ids réservés par la page : {sorted(IDS_RESERVES & set(ids))}")
    nb_mots = len(mots(texte(article)))
    if nb_mots < 500:
        err.append(f"article.html : {nb_mots} mots seulement (700 au moins conseillés)")
    elif not 700 <= nb_mots <= 2200:
        av.append(f"article.html : {nb_mots} mots (700 à 2200 conseillés)")
    nom_court = " ".join(mots(f.get("nom_court", "")))
    if nom_court and nb_mots:
        densite = " ".join(mots(texte(article))).count(nom_court) * 1000 / nb_mots
        if densite > 12:
            av.append(f"« {f.get('nom_court')} » répété {densite:.0f} fois pour 1000 mots : variez (bourrage de mots-clés)")

    # Modèle de contrat (ou grille de revue)
    lignes = [l for l in modele.splitlines() if l.strip()]
    if revue:
        if not lignes or not lignes[0].startswith("# "):
            err.append("grille.txt : la première ligne doit être le titre (« # … »)")
        if sum(1 for l in lignes if l.startswith("## ")) < 5:
            err.append("grille.txt : moins de 5 rubriques (« ## … »)")
        if sum(1 for l in lignes if l.startswith("- ")) < 20:
            err.append("grille.txt : moins de 20 points de contrôle (« - … »)")
        if not any(l.startswith("> ") for l in lignes):
            av.append("grille.txt : aucune note (« > … »)")
    else:
        if not lignes or not lignes[0].startswith("# "):
            err.append("modele.txt : la première ligne doit être le titre (« # … »)")
        if sum(1 for l in lignes if l.startswith("## ")) < 6:
            err.append("modele.txt : moins de 6 articles (« ## … »)")
        if not any(l.startswith("> ") for l in lignes):
            av.append("modele.txt : aucune note de rédaction (« > … »)")
        if "signature" not in modele.lower():
            av.append("modele.txt : pas de bloc de signature")
    for l in lignes:
        if l.count("[") != l.count("]"):
            av.append(f"{nom_texte} : crochets déséquilibrés : « {l[:70]} »")

    # Mots et affirmations interdits
    partout = sans_accents(f"{fiche_txt} {texte(article)} {modele}")
    trouve = re.search(r"\bavocat", partout)
    if trouve:
        err.append("le mot « avocat » est interdit : aucun avocat dans l'équipe (REFERENTIEL-LEGAL.md) : "
                   f"« …{partout[max(0, trouve.start() - 40):trouve.end() + 20]}… »")
    editorial = sans_accents(f"{propre} {md} {ts} {f.get('titre_h1', '')}")
    for liste, cible in ((INTERDITS, err), (A_SURVEILLER, av)):
        for motif, raison in liste:
            trouve = re.search(motif, editorial)
            if trouve:
                cible.append(f"{raison} : « …{editorial[max(0, trouve.start() - 40):trouve.end() + 20]}… »")
    if not valide:
        trouve = re.search(RELECTURE, editorial)
        if trouve:
            err.append(f"affirmation de relecture humaine alors que relecture.valide = false : « {trouve.group(0)} »")

    # Ressemblance avec les autres pages (contenu dupliqué)
    t_page = tuiles(mots(propre))
    toutes_autres = set()
    for d in autres_dossiers:
        try:
            f2, txt2 = corpus(d)
        except (OSError, ValueError):
            continue
        t2 = tuiles(mots(txt2))
        toutes_autres |= t2
        part = len(t_page & t2) / len(t_page) if t_page else 0
        if part > 0.20:
            err.append(f"{part:.0%} du texte repris de « {d.name} » : réécrivez (contenu dupliqué)")
        elif part > 0.10:
            av.append(f"{part:.0%} du texte proche de « {d.name} »")
        if f2.get("titre_seo") == ts or f2.get("meta_description") == md:
            err.append(f"titre_seo ou meta_description identique à « {d.name} »")
        if f2.get("mot_cle", "").lower() == f.get("mot_cle", "").lower():
            err.append(f"même mot-clé principal que « {d.name} » : deux pages se feraient concurrence")
        questions = {" ".join(mots(q)) for q, _ in f2.get("faq", [])}
        for q, _ in f.get("faq", []):
            if " ".join(mots(q)) in questions:
                av.append(f"FAQ : question identique sur « {d.name} » : « {q[:60]} »")
    for ph in phrases_copiees(propre, toutes_autres)[:8]:
        av.append(f"phrase déjà présente sur une autre page : « {ph} »")

    relire = [f"Articles de loi cités ({len(articles_cites(tout))}) : " + "; ".join(articles_cites(tout)),
              "Chiffres et délais cités : " + ", ".join(chiffres(tout))]
    return err, av, relire
