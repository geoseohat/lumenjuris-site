# -*- coding: utf-8 -*-
"""Pages « Guide de revue contractuelle » de www.lumenjuris.com.

Même fonctionnement que modeles_contrat.py (dont ce fichier réutilise tout le moteur :
fichiers Word/PDF/image, ordres pour le serveur o2switch, synchronisation), avec :
  - les guides rangés sous la page « Révision contractuelle IA » (/revision-contractuelle-ia/),
    dans la bibliothèque /revision-contractuelle-ia/guide-revue-contrat/ ;
  - à la place du contrat, une grille de revue (grille.txt) à télécharger ;
  - à la place du bouton « Personnaliser », un bouton « Analyser mon contrat » vers
    l'outil d'analyse et de revue de l'application.

Chaque guide vit dans wordpress-vitrine/revues-contrat/<slug>/ :
  fiche.json    titre, description Google, FAQ, étapes, sources...
  article.html  contenu explicatif (sections <h2>)
  grille.txt    grille de revue (# titre, ## rubrique, "- " point à vérifier, "> " note)

Usage (depuis wordpress-vitrine/) :
  python outils/revues_contrat.py preparer                    -> guide du jour, doublons, dossier prérempli
  python outils/revues_contrat.py controler <slug>            -> contrôle qualité
  python outils/revues_contrat.py publier <slug> [--en-ligne --sans-relecture]
  python outils/revues_contrat.py terminer <slug> --mode normal|test
  python outils/revues_contrat.py ecarter "<raison>"
  python outils/revues_contrat.py retirer <slug>              -> repasse la page en brouillon
  python outils/revues_contrat.py construire <slug>           -> Word, PDF, aperçu local
  python outils/revues_contrat.py liste | synchroniser | valider <slug>

Les ordres sont écrits dans modeles-contrat/ordres/, le seul dossier que lit le serveur
o2switch : aucune modification du serveur n'est nécessaire.
"""
import json
import re
import sys
import urllib.parse
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import modeles_contrat as mc  # noqa: E402

e, de, date_fr, SITE, ORG = mc.e, mc.de, mc.date_fr, mc.SITE, mc.ORG

DOSSIER = Path(__file__).resolve().parents[1] / "revues-contrat"
DOSSIER_MODELES = mc.DOSSIER  # pour proposer les modèles de contrat liés
PARENT_ID = 2842  # page « Révision contractuelle IA »
PARENT_URL = f"{SITE}/revision-contractuelle-ia/"
BIBLIO_SLUG = "guide-revue-contrat"
BIBLIO_URL = f"{PARENT_URL}{BIBLIO_SLUG}/"
BIBLIO_TITRE = "Guides de revue contractuelle"
# Outil « Analyse et revue » de l'application (menu Pilotage > Analyse et revue).
APP_ANALYSE = "https://app.lumenjuris.com/conformite"
REFERENCES = mc.DEPOT / ".claude" / "skills" / "routine-revue-contrat" / "references"
CMD = "python outils/revues_contrat.py"

OUTILS = [
    ("Analyse et révision de contrat par IA", PARENT_URL),
    ("Négociation de contrats", f"{SITE}/negociation-de-contrat/"),
    ("Modèles de contrat gratuits", mc.BIBLIO_URL),
]

# Le moteur de modeles_contrat.py travaille sur ces réglages : on les remplace.
# ORDRES n'est pas remplacé : le serveur ne lit que modeles-contrat/ordres/.
mc.DOSSIER = DOSSIER
mc.ETAT = DOSSIER / "etat.json"
mc.TEXTE = "grille.txt"
mc.PARENT_ID, mc.PARENT_URL, mc.PARENT_TITRE = PARENT_ID, PARENT_URL, "Révision contractuelle IA"
mc.BIBLIO_SLUG, mc.BIBLIO_URL, mc.BIBLIO_TITRE = BIBLIO_SLUG, BIBLIO_URL, BIBLIO_TITRE
mc.MOTS_CLES = DOSSIER / "mots-cles.txt"
mc.JOURNAL = DOSSIER / "journal-routine.txt"
mc.EN_COURS = DOSSIER / ".en-cours.json"
mc.OUTILS = OUTILS

ICO_LOUPE = ('<svg class="lj-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/>'
             '<path d="m21 21-4.3-4.3"/></svg>')
ICO_DL = ('<svg class="lj-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/>'
          '<path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>')


def fiche(slug):
    f = json.loads((DOSSIER / slug / "fiche.json").read_text(encoding="utf-8"))
    f["url"] = f"{BIBLIO_URL}{slug}/"
    sujet = f["analyser"].get("sujet") or f["nom_court"]
    f["analyser"]["url"] = f"{APP_ANALYSE}?de=guide&sujet={urllib.parse.quote_plus(sujet.lower())}"
    # Textes des fichiers Word, PDF et de l'image (moteur commun).
    f.setdefault("titre_document", f"Grille de revue : {f['nom_court']}")
    f["alt_image"] = f"Grille de revue gratuite : {f['nom_court']} – Lumen Juris"
    f["pied_document"] = "Grille de revue Lumen Juris"
    f["image_surtitre"] = "Guide de revue contractuelle"
    f["image_badges"] = ["Grille Word", "PDF", "Analyse IA"]
    # Le moteur attend un bouton « personnaliser » : il n'est pas affiché sur ces pages.
    f["personnaliser"] = {"url": f["analyser"]["url"]}
    return f


def modeles_lies(f):
    """Modèles de contrat en ligne cités par le guide (fiche « modeles_lies »), sinon même catégorie."""
    etat = json.loads((DOSSIER_MODELES / "etat.json").read_text(encoding="utf-8"))
    en_ligne = [s for s, em in etat["modeles"].items()
                if em.get("statut") == "publish" and (DOSSIER_MODELES / s / "fiche.json").exists()]
    choisis = [s for s in f.get("modeles_lies", []) if s in en_ligne]
    if not choisis:
        choisis = [s for s in en_ligne if json.loads((DOSSIER_MODELES / s / "fiche.json").read_text(
            encoding="utf-8"))["categorie"] == f["categorie"]][:2]
    res = []
    for s in choisis[:3]:
        fm = json.loads((DOSSIER_MODELES / s / "fiche.json").read_text(encoding="utf-8"))
        res.append((f"Modèle {de(fm['nom_court'])}", f"{mc.BIBLIO_URL}{s}/"))
    return res


def page_guide(slug, etat, publics_seulement=True):
    f = fiche(slug)
    em = etat["modeles"].get(slug, {})
    fich = mc.fichiers_telechargement(em)
    blocs = mc.blocs_modele(slug)
    rel = f["relecture"]
    article = (DOSSIER / slug / "article.html").read_text(encoding="utf-8")
    sommaire = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', article)
    sommaire = [("grille", "La grille de revue")] + sommaire + [
        ("etapes", "Relire le contrat en 5 étapes"), ("faq", "Questions fréquentes")]
    docx, pdf = fich.get("docx", {}), fich.get("pdf", {})
    actions = (
        f'<a class="lj-btn lj-btn-plein" href="{e(f["analyser"]["url"])}" rel="nofollow">{ICO_LOUPE}Analyser mon contrat</a>'
        f'<details class="lj-dl"><summary class="lj-btn lj-btn-plein">{ICO_DL}Télécharger</summary>'
        f'<div class="lj-dl-menu">'
        f'<a href="{e(docx.get("url", "#"))}" download>Word <small>.docx · {e(docx.get("taille", ""))}</small></a>'
        f'<a href="{e(pdf.get("url", "#"))}" download>PDF <small>.pdf · {e(pdf.get("taille", ""))}</small></a>'
        f'</div></details>')
    associes = mc.modeles_associes(slug, etat, publics_seulement)
    lies = modeles_lies(f)
    cartes = "".join(f'<li><a href="{e(a["url"])}">{e(a["nom"])}</a><p>{e(a["categorie"])}</p></li>'
                     for a in associes[:4])
    cartes += "".join(f'<li><a href="{e(url)}">{e(nom)}</a><p>Modèle de contrat gratuit</p></li>' for nom, url in lies)
    cartes += "".join(f'<li><a href="{e(url)}">{e(nom)}</a><p>Outil Lumen Juris</p></li>' for nom, url in OUTILS)
    if rel["valide"]:
        role, presentation = rel["fonction"], f"{rel['presentation']} Dernière relecture le {date_fr(rel['date_validation'])}."
    else:
        role = "Rédaction des guides de revue contractuelle"
        presentation = ("Ce guide est rédigé à partir des textes de loi en vigueur, cités en sources ci-dessous, "
                        f"et a été mis à jour le {date_fr(f['date_mise_a_jour'])}.")

    h = [f"<style>{mc.CSS_MIN}</style>",
         '<div class="lj-mc">',
         f'<p class="lj-maj">Mis à jour le <time datetime="{f["date_mise_a_jour"]}">{date_fr(f["date_mise_a_jour"])}</time></p>',
         mc.FIL_ARIANE,
         f'<p class="lj-chapo">{e(f["chapo"])}</p>',
         '<nav class="lj-sommaire" aria-label="Sommaire"><p>Sommaire</p><ol>'
         + "".join(f'<li><a href="#{i}">{t}</a></li>' for i, t in sommaire) + "</ol></nav>",
         f'<h2 id="grille">La grille de revue</h2>'
         f'<section class="lj-modele" aria-labelledby="grille">'
         f'<div class="lj-modele-tete">{actions}</div>'
         f'<div class="lj-modele-texte" tabindex="0" role="region" aria-label="Grille de revue">{mc.modele_html(blocs)}</div>'
         f'<div class="lj-modele-pied"><p>Grille gratuite, sans inscription. Pour une revue clause par clause de votre '
         f'propre document, utilisez « Analyser mon contrat ».</p></div></section>',
         article,
         f'<h2 id="etapes">Relire le contrat en 5 étapes</h2><ol class="lj-etapes">'
         + "".join(f'<li id="etape-{i}"><strong>{e(n)}</strong>{e(t)}</li>' for i, (n, t) in enumerate(f["etapes"], 1))
         + "</ol>",
         '<h2 id="faq">Questions fréquentes</h2><div class="lj-faq">'
         + "".join(f"<details><summary>{e(q)}</summary><div><p>{e(r)}</p></div></details>" for q, r in f["faq"])
         + "</div>",
         '<section class="lj-auteur" aria-labelledby="auteur">'
         '<div class="lj-avatar" aria-hidden="true">LJ</div>'
         f'<div><h2 id="auteur">{e(rel["nom"])}</h2><p class="lj-role">{e(role)}</p>'
         f'<p>{e(presentation)}</p><p><a href="{e(rel["url_profil"])}">Découvrir l\'équipe Lumen Juris</a></p>'
         '<p class="lj-role">Ce guide est fourni à titre informatif. Il ne remplace pas un conseil personnalisé adapté à votre situation.</p></div></section>',
         '<section class="lj-sources" aria-label="Sources"><h2>Sources</h2><ul>'
         + "".join(f'<li><a href="{e(url)}" rel="noopener" target="_blank">{e(nom)}</a></li>' for nom, url in f["sources"])
         + "</ul></section>",
         f'<section aria-labelledby="associes"><h2 id="associes">Pour aller plus loin</h2><ul class="lj-cartes">{cartes}</ul></section>',
         "</div>",
         f'<script type="application/ld+json">{json.dumps(schema_guide(f, blocs, fich, associes, lies, em.get("image")), ensure_ascii=False, separators=(",", ":"))}</script>']
    return "<!-- wp:html -->\n" + "\n".join(h) + "\n<!-- /wp:html -->"


def schema_guide(f, blocs, fich, associes, lies, image=None):
    u, rel = f["url"], f["relecture"]
    equipe = f"{SITE}/#equipe-juridique"
    encodages = [{"@type": "MediaObject", "name": f"{f['titre_document']} ({fmt})",
                  "contentUrl": fich[k]["url"], "encodingFormat": mime, "contentSize": fich[k].get("taille")}
                 for k, fmt, mime in (("docx", "Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                                      ("pdf", "PDF", "application/pdf")) if k in fich]
    page = {
        "@type": "WebPage", "@id": f"{u}#webpage", "url": u, "name": f["titre_seo"],
        "description": f["meta_description"], "inLanguage": "fr-FR",
        "isPartOf": {"@id": f"{SITE}/#website"}, "breadcrumb": {"@id": f"{u}#breadcrumb"},
        "mainEntity": {"@id": f"{u}#article"}, "about": {"@id": f"{u}#sujet"},
        "datePublished": f["date_publication"], "dateModified": f["date_mise_a_jour"],
        "hasPart": [{"@id": f"{u}#grille"}, {"@id": f"{u}#faq"}, {"@id": f"{u}#howto"}],
        "speakable": {"@type": "SpeakableSpecification", "cssSelector": [".lj-chapo"]},
        "relatedLink": [a["url"] for a in associes] + [url for _, url in lies] + [url for _, url in OUTILS],
        "publisher": ORG,
    }
    if rel["valide"]:
        page["reviewedBy"] = {"@id": equipe}
        page["lastReviewed"] = rel["date_validation"]
    article = {
        "@type": "Article", "@id": f"{u}#article", "headline": f["titre_h1"], "description": f["meta_description"],
        "inLanguage": "fr-FR", "author": {"@id": equipe}, "publisher": ORG,
        "datePublished": f["date_publication"], "dateModified": f["date_mise_a_jour"],
        "mainEntityOfPage": {"@id": f"{u}#webpage"}, "about": {"@id": f"{u}#sujet"},
        "articleSection": "Revue contractuelle",
        "keywords": ", ".join([f["mot_cle"]] + f["mots_cles_secondaires"]), "isAccessibleForFree": True,
        "audience": {"@type": "Audience", "audienceType": f.get("public", "Entreprises, indépendants et dirigeants")},
        "citation": [{"@type": "Legislation", "name": nom, "url": url, "legislationJurisdiction": "FR",
                      "inLanguage": "fr-FR"} for nom, url in f["sources"]],
    }
    grille = {
        "@type": "DigitalDocument", "@id": f"{u}#grille", "name": f["titre_document"],
        "genre": "Grille de revue contractuelle", "inLanguage": "fr-FR", "isAccessibleForFree": True,
        "author": {"@id": equipe}, "publisher": ORG, "about": {"@id": f"{u}#sujet"},
        "isPartOf": {"@id": f"{u}#webpage"}, "encoding": encodages,
        "potentialAction": [{"@type": "DownloadAction", "target": x["contentUrl"]} for x in encodages],
    }
    if image:
        img = {"@type": "ImageObject", "@id": f"{u}#image", "url": image["url"], "contentUrl": image["url"],
               "width": 1200, "height": 630, "caption": f"{f['titre_document']} – Lumen Juris", "inLanguage": "fr-FR"}
        page["primaryImageOfPage"] = page["image"] = article["image"] = {"@id": f"{u}#image"}
    graphe = [
        page, article, grille,
        {"@type": "Thing", "@id": f"{u}#sujet", "name": f["nom"], "alternateName": f["mots_cles_secondaires"]},
        {"@type": "HowTo", "@id": f"{u}#howto", "name": f"Comment relire : {f['nom_court']}", "inLanguage": "fr-FR",
         "step": [{"@type": "HowToStep", "position": i, "name": n, "text": t, "url": f"{u}#etape-{i}"}
                  for i, (n, t) in enumerate(f["etapes"], 1)]},
        {"@type": "FAQPage", "@id": f"{u}#faq", "url": u, "inLanguage": "fr-FR",
         "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": r}}
                        for q, r in f["faq"]]},
        {"@type": "Organization", "@id": equipe, "name": rel["nom"],
         "description": "Service de Lumen Juris chargé de la rédaction des contenus juridiques publiés sur "
                        "www.lumenjuris.com.", "url": rel["url_profil"], "parentOrganization": ORG,
         "knowsAbout": rel["domaines"]},
    ]
    if image:
        graphe.append(img)
    return {"@context": "https://schema.org", "@graph": graphe}


def page_bibliotheque(etat, publics_seulement=True):
    slugs = [s for s in mc.tous_les_slugs()
             if not publics_seulement or etat["modeles"].get(s, {}).get("statut") == "publish"]
    par_cat = {}
    for s in slugs:
        f = fiche(s)
        par_cat.setdefault(f["categorie"], []).append(f)
    sections = []
    for cat in sorted(par_cat):
        cartes = "".join(
            f'<li><a href="{e(f["url"])}">{e(f["nom"])}</a><p>{e(f["meta_description"][:140])}…</p></li>'
            for f in sorted(par_cat[cat], key=lambda x: x["nom"]))
        sections.append(f'<h2>{e(cat)}</h2><ul class="lj-cartes">{cartes}</ul>')
    toutes = [fiche(s) for s in slugs]
    schema = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "@id": f"{BIBLIO_URL}#bibliotheque", "url": BIBLIO_URL,
         "name": BIBLIO_TITRE, "inLanguage": "fr-FR", "isPartOf": {"@id": f"{SITE}/#website"},
         "publisher": ORG, "mainEntity": {"@id": f"{BIBLIO_URL}#liste"},
         "breadcrumb": {"@id": f"{BIBLIO_URL}#breadcrumb"}},
        {"@type": "ItemList", "@id": f"{BIBLIO_URL}#liste", "numberOfItems": len(toutes),
         "itemListElement": [{"@type": "ListItem", "position": i, "url": f["url"], "name": f["nom"]}
                             for i, f in enumerate(toutes, 1)]}]}
    h = [f"<style>{mc.CSS_MIN}</style>",
         '<div class="lj-mc">',
         mc.FIL_ARIANE,
         '<p class="lj-chapo">Des guides pour relire un contrat ou une clause avant de signer : points de vigilance, '
         'clauses à risque, règles impératives et grille de revue gratuite à télécharger en Word ou en PDF. Pour '
         'votre propre document, l\'analyse par IA de Lumen Juris le passe en revue clause par clause.</p>',
         *sections,
         "</div>",
         f'<script type="application/ld+json">{json.dumps(schema, ensure_ascii=False, separators=(",", ":"))}</script>']
    return "<!-- wp:html -->\n" + "\n".join(h) + "\n<!-- /wp:html -->"


def bibliotheque(etat, statut):
    """Crée ou met à jour la page /revision-contractuelle-ia/guide-revue-contrat/."""
    b = etat.setdefault("bibliotheque", {})
    en_ligne = statut == "publish" or b.get("statut") == "publish"
    donnees = {"title": BIBLIO_TITRE, "slug": BIBLIO_SLUG, "parent": PARENT_ID,
               "content": page_bibliotheque(etat, publics_seulement=en_ligne),
               "status": "publish" if en_ligne else "draft"}
    p = mc.ecrire_page(b.get("id"), donnees, BIBLIO_SLUG)
    b.update(id=p["id"], statut=p["status"])
    mc.meta_seo(p["id"], "Guides de revue de contrat et grilles gratuites | Lumen Juris",
                "Guides pour relire un contrat ou une clause avant de signer : points de vigilance, clauses à risque "
                "et grilles de revue gratuites en Word ou PDF.", "grille de revue de contrat")
    return p


def controle(slug, afficher=True):
    """Contrôle qualité, comparé aux autres guides ET aux modèles de contrat (contenu dupliqué)."""
    import qualite_modele
    autres = [DOSSIER / s for s in mc.tous_les_slugs() if s != slug]
    autres += [p for p in sorted(DOSSIER_MODELES.iterdir())
               if (p / "fiche.json").exists() and not p.name.startswith(("_", "."))]
    erreurs, avertissements, a_relire = qualite_modele.controler(DOSSIER / slug, autres, genre="revue")
    if afficher:
        print(f"Contrôle qualité de {slug} : {len(erreurs)} erreur(s), {len(avertissements)} avertissement(s)")
        for x in erreurs:
            print(f"  ERREUR  {x}")
        for x in avertissements:
            print(f"  attention  {x}")
        print("À relire vous-même (exactitude) :")
        for x in a_relire:
            print(f"  - {x}")
    return len(erreurs)


def pages_proches(ligne, sauf=None):
    """Guides existants, et modèles de contrat, qui visent peut-être la même recherche."""
    import qualite_modele
    cherche, j = " ".join(qualite_modele.mots(ligne)), mc.jetons(ligne)
    res = []
    dossiers = [(DOSSIER / s, "guide") for s in mc.tous_les_slugs() if s != sauf]
    dossiers += [(p, "modèle") for p in sorted(DOSSIER_MODELES.iterdir())
                 if (p / "fiche.json").exists() and not p.name.startswith(("_", "."))]
    for d, genre in dossiers:
        f = json.loads((d / "fiche.json").read_text(encoding="utf-8"))
        cibles = [f["nom_court"], f["mot_cle"], *f.get("mots_cles_secondaires", [])]
        exact = any(cherche in " ".join(qualite_modele.mots(c)) for c in cibles)
        score = max((len(j & mc.jetons(c)) / len(j | mc.jetons(c)) for c in cibles if j | mc.jetons(c)), default=0)
        if exact or score >= 0.34:
            res.append((1.0 if exact else score, f"{genre} {d.name}", f))
    return sorted(res, key=lambda x: -x[0])[:4]


def doublon_connu(ligne):
    """Décision déjà prise pour cette ligne dans le tableau de references/doublons.md."""
    import qualite_modele
    ref = REFERENCES / "doublons.md"
    if not ref.exists():
        return None
    cherche = " ".join(qualite_modele.mots(ligne))
    for l in ref.read_text(encoding="utf-8").splitlines():
        cases = [c.strip() for c in l.strip().strip("|").split("|")]
        if len(cases) == 3 and " ".join(qualite_modele.mots(cases[0])) == cherche:
            return cases[1], cases[2]
    return None


A = mc.A_COMPLETER


def creer_squelette(ligne, slug):
    """Dossier du guide prérempli : seuls les « À COMPLÉTER » restent à écrire."""
    d = DOSSIER / slug
    d.mkdir()
    nom_court = re.sub(r"\s*\([^)]*\)", "", ligne).strip()
    aujourd_hui = str(date.today())
    categories = sorted({fiche(s)["categorie"] for s in mc.tous_les_slugs() if s != slug}
                        | {"Clauses du contrat", "Contrats commerciaux", "Contrats de travail", "Baux et immobilier",
                           "Sociétés et associés"})
    modeles = sorted(p.name for p in DOSSIER_MODELES.iterdir() if (p / "fiche.json").exists() and not p.name.startswith(("_", ".")))
    f = {
        "slug": slug,
        "nom": nom_court[:1].upper() + nom_court[1:],
        "nom_court": nom_court,
        "categorie": f"{A} : une catégorie ({' / '.join(categories)})",
        "mot_cle": nom_court.lower(),
        "mots_cles_secondaires": [f"{A} : 3 à 8 recherches proches réellement tapées"],
        "titre_h1": f"{A} : titre visible, ex. « {nom_court[:1].upper() + nom_court[1:]} : points à vérifier avant de signer »",
        "titre_seo": f"{A} : 65 caractères au plus, avec l'année {date.today().year} si utile",
        "meta_description": f"{A} : 120 à 160 caractères, ce que le guide apprend et ce que contient la grille",
        "chapo": f"{A} : 2 phrases, le risque concret pour le lecteur et ce que propose la page",
        "public": f"{A} : à qui s'adresse le guide (ex. « Dirigeants de PME et indépendants »)",
        "titre_document": f"Grille de revue : {nom_court}",
        "gratuit": True,
        "fichier_base": f"grille-revue-{slug}-lumen-juris",
        "date_publication": aujourd_hui,
        "date_mise_a_jour": aujourd_hui,
        "relecture": {
            "nom": "L'équipe juridique de Lumen Juris",
            "fonction": "Rédaction et relecture des guides de revue contractuelle",
            "presentation": "Les guides de revue contractuelle publiés par Lumen Juris sont rédigés et relus par notre "
                            "équipe juridique, afin de vérifier leur conformité au droit français en vigueur.",
            "url_profil": f"{SITE}/qui-sommes-nous/",
            "domaines": [f"{A} : 2 ou 3 domaines du droit (ex. « Droit des contrats »)"],
            "valide": False,
            "date_validation": None,
        },
        "modeles_lies": [f"{A} : 0 à 3 modèles de contrat liés parmi : {', '.join(modeles)} (liste vide permise)"],
        "etapes": [[f"{A} : titre de l'étape {i}", f"{A} : ce que le lecteur vérifie, propre à ce contrat ou cette clause"]
                   for i in range(1, 6)],
        "faq": [[f"{A} : question réellement posée {i} ?", f"{A} : réponse exacte, 2 à 4 phrases"] for i in range(1, 7)],
        "sources": [[f"{A} : Code …, articles … (objet)", "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006070721"],
                    [f"{A} : Code …, articles … (objet)", "https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006070721"]],
        "analyser": {"sujet": nom_court},
    }
    (d / "fiche.json").write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    t = f"{A} : titre propre à ce sujet"
    (d / "article.html").write_text(f"""<h2 id="enjeux">{t} (à quoi sert ce contrat ou cette clause, ce qui se joue pour le lecteur)</h2>
<p>{A}</p>

<h2 id="points-cles">{t} (les points à vérifier en priorité, et pourquoi)</h2>
<ul class="lj-clauses">
<li><strong>{A}</strong> : {A}</li>
</ul>

<h2 id="clauses-risque">{t} (clauses illicites, abusives ou déséquilibrées : ce que dit la loi)</h2>
<div class="lj-table-wrap">
<table class="lj-table">
<thead><tr><th scope="col">{A}</th><th scope="col">{A}</th><th scope="col">{A}</th></tr></thead>
<tbody>
<tr><th scope="row">{A}</th><td>{A}</td><td>{A}</td></tr>
</tbody>
</table>
</div>

<h2 id="exemple">{t} (exemple concret de clause à risque et de reformulation, présenté comme un exemple)</h2>
<p>{A}</p>

<h2 id="negocier">{t} (ce qu'on peut négocier, et comment le demander)</h2>
<p>{A}</p>

<h2 id="limites">{t} (cas où une relecture par un professionnel s'impose)</h2>
<p>{A}</p>
""", encoding="utf-8")
    (d / "grille.txt").write_text(f"""# GRILLE DE REVUE : {nom_court.upper()}

> Grille gratuite Lumen Juris. Répondez à chaque question en relisant le contrat. Une réponse « non » n'est pas forcément une erreur, mais elle mérite une question à l'autre partie.

## 1. {A} : RUBRIQUE

- {A} : point à vérifier, formulé comme une question fermée
""", encoding="utf-8")


def preparer():
    """Comme modeles_contrat.preparer, avec le squelette et les doublons des guides."""
    DOSSIER.mkdir(exist_ok=True)
    mc.creer_squelette, mc.resume = creer_squelette, resume
    mc.preparer()


def resume(ligne, slug):
    print(f"\nGUIDE DU JOUR : {ligne}")
    print(f"  dossier : wordpress-vitrine/revues-contrat/{slug}/ (fiche.json, article.html, grille.txt)")
    print(f"  adresse prévue : {BIBLIO_URL}{slug}/")
    connu = doublon_connu(ligne)
    if connu:
        print(f"\nDOUBLON CONNU (references/doublons.md) : proche de {connu[0]}")
        print(f"  décision conseillée : {connu[1]}")
    proches = pages_proches(ligne, sauf=slug)
    if proches:
        print("\nPAGES EXISTANTES PROCHES : même recherche Google ? (deux pages pour la même intention = doublon)")
        for score, nom, f in proches:
            print(f"  - {nom} : « {f['nom']} » ({score:.0%}) – mots-clés : {', '.join(f.get('mots_cles_secondaires', [])[:5])}")
        print("  Un guide de revue et un modèle de contrat peuvent coexister s'ils répondent à des recherches différentes")
        print("  (« modèle de … » contre « clause … », « vérifier … », « relire … »). Sinon :")
        print(f'    {CMD} ecarter "même intention que <slug> : <explication>"')
    else:
        print("\nAucune page existante proche.")
    print("\nGuides existants (catégories, cohérence) :")
    etat = mc.lire_etat()
    for s in mc.tous_les_slugs():
        if s != slug:
            print(f"  - {s} ({etat['modeles'].get(s, {}).get('statut', 'jamais publié')}) : {fiche(s)['categorie']}")
    print("\nÀ FAIRE : remplacer tous les « À COMPLÉTER » (compétence routine-revue-contrat), puis :")
    print(f"  {CMD} controler {slug}")


def terminer(slug, mode):
    f = fiche(slug)
    c = json.loads(mc.EN_COURS.read_text(encoding="utf-8")) if mc.EN_COURS.exists() else {}
    etat = mc.lire_etat()
    ordre = next((o for o in reversed(etat.get("ordres_en_attente", [])) if o.endswith(f"-{slug}")), None)
    if not ordre and not etat["modeles"].get(slug, {}).get("id"):
        sys.exit(f"Rien n'a été publié pour {slug} : lancez « publier » avant « terminer ».")
    test = mode.lower() == "test"
    if c.get("slug") == slug:
        mc.cocher(c["ligne"], f["url"] + (" (brouillon test)" if test else ""))
    mc.noter_journal(f"{date.today()} | {f['nom']} | {f['url']} | mode {'TEST (brouillon)' if test else 'NORMAL (en ligne)'} : "
                     + (f"ordre {ordre} confié au serveur o2switch" if ordre else
                        f"page {etat['modeles'].get(slug, {}).get('id')} ({etat['modeles'].get(slug, {}).get('statut')})")
                     + " ; contrôle qualité réussi ; vérifications en ligne au prochain passage (synchroniser)")
    mc.EN_COURS.unlink(missing_ok=True)
    print("mots-cles.txt et journal-routine.txt à jour. Reste à enregistrer sur GitHub :")
    print('  git add wordpress-vitrine/revues-contrat wordpress-vitrine/modeles-contrat/ordres && '
          'git commit -m "Guide de revue du jour : …" && git push origin claude/modeles-contrat')


def valider(slug):
    """À lancer seulement quand la juriste a réellement relu le guide."""
    p = DOSSIER / slug / "fiche.json"
    f = json.loads(p.read_text(encoding="utf-8"))
    f["relecture"].update(valide=True, date_validation=str(date.today()))
    p.write_text(json.dumps(f, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{slug} : relecture enregistrée au {date_fr(str(date.today()))}. Pour l'afficher sur le site :")
    print(f"  {CMD} publier {slug} --en-ligne")


# Le moteur commun appelle ces fonctions : il les trouve ici à la place des siennes.
mc.fiche, mc.page_modele, mc.page_bibliotheque, mc.bibliotheque = fiche, page_guide, page_bibliotheque, bibliotheque
mc.controle, mc.pages_proches, mc.doublon_connu = controle, pages_proches, doublon_connu


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    DOSSIER.mkdir(exist_ok=True)
    cmd, args = (sys.argv[1], sys.argv[2:]) if len(sys.argv) > 1 else ("", [])
    if cmd == "construire":
        mc.construire(args[0])
        mc.apercu(args[0], mc.lire_etat())
    elif cmd == "publier":
        mc.publier(args[0], en_ligne="--en-ligne" in args, sans_relecture="--sans-relecture" in args,
                   forcer="--forcer" in args)
        mc.apercu(args[0], mc.lire_etat())
    elif cmd == "retirer":
        mc.retirer(args[0])
    elif cmd == "liste":
        mc.liste()
    elif cmd == "synchroniser":
        mc.synchroniser()
    elif cmd == "preparer":
        preparer()
    elif cmd == "controler":
        sys.exit(1 if controle(args[0]) else 0)
    elif cmd == "terminer":
        terminer(args[0], args[args.index("--mode") + 1] if "--mode" in args else "normal")
    elif cmd == "ecarter":
        mc.ecarter(" ".join(args))
    elif cmd == "valider":
        valider(args[0])
    else:
        sys.exit(__doc__)
