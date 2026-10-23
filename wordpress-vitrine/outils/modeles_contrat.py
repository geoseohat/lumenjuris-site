# -*- coding: utf-8 -*-
"""Pages « Modèle de contrat » de www.lumenjuris.com.

Chaque modèle vit dans wordpress-vitrine/modeles-contrat/<slug>/ :
  fiche.json    titre, description Google, FAQ, étapes, relecture juridique...
  article.html  contenu explicatif (sections <h2>)
  modele.txt    texte du contrat (# titre, ## article, ### sous-article,
                "- " liste, "> " note de rédaction, [champ à compléter])

Usage :
  python modeles_contrat.py construire <slug>          -> Word, PDF, aperçu local
  python modeles_contrat.py publier <slug>             -> brouillon sur le site
  python modeles_contrat.py publier <slug> --en-ligne  -> mise en ligne publique
  python modeles_contrat.py retirer <slug>             -> repasse la page en brouillon
  python modeles_contrat.py liste                      -> état de chaque modèle
  python modeles_contrat.py synchroniser               -> relit ce que le serveur a publié

La page parente /modele-contrat/ (bibliothèque) est créée et régénérée
automatiquement, ainsi que le bloc « Modèles associés » de chaque page.

Publication par le serveur (routine cloud) : depuis le 16 oct. 2026, la protection
anti-robots d'o2switch (Tiger Protect) refuse les envois venant du cloud. Dans la
routine (variables WP_USER / WP_APP_PASSWORD), « publier » et « retirer » n'envoient
donc rien au site : ils écrivent un ordre dans modeles-contrat/ordres/. Une fois
l'ordre enregistré sur GitHub, le serveur o2switch le récupère et l'exécute lui-même
(outils/serveur/publication-lumenjuris.php, tâche programmée du cPanel). Les numéros
de pages et de fichiers sont relus au passage suivant (« synchroniser »).
PUBLICATION_DIRECTE=1 force l'ancien envoi direct.
"""
import base64
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import wp_api  # noqa: E402

DEPOT = Path(__file__).resolve().parents[2]
DOSSIER = Path(__file__).resolve().parents[1] / "modeles-contrat"
ETAT = DOSSIER / "etat.json"
ORDRES = DOSSIER / "ordres"
SITE = "https://www.lumenjuris.com"
# Compte rendu public du serveur (numéros de pages et adresses des fichiers seulement).
RESULTATS_URL = f"{SITE}/wp-content/uploads/lumenjuris-publication/resultats.json"
DIFFERE = bool(os.environ.get("WP_APP_PASSWORD")) and not os.environ.get("PUBLICATION_DIRECTE")
# Repère remplacé par le serveur : {{<ordre>.<opération>.<champ>}}, ex. {{20261023-180000-publier-statuts-sas.o3.id}}
REPERE = re.compile(r"\{\{[\w-]+\.o\d+\.\w+\}\}")
# La bibliothèque est rangée sous la page « Outil génération contrat IA » : le fil
# d'Ariane de Rank Math suit cette hiérarchie (choix de Geoff, 25 sept 2026).
PARENT_ID = 2630
PARENT_URL = f"{SITE}/outil-generation-contrat-ia/"
PARENT_TITRE = "Générateur de contrat IA"  # nom court réglé dans Rank Math (page 2630)
BIBLIO_SLUG = "modele-contrat"
BIBLIO_URL = f"{PARENT_URL}{BIBLIO_SLUG}/"
BIBLIO_TITRE = "Modèles juridiques gratuits"
ORG = {"@id": f"{SITE}/#organization"}
# Navigateur sans fenêtre pour le PDF et l'image : Edge sur le PC,
# Chrome/Chromium dans la routine cloud (variable NAVIGATEUR pour forcer).
# Dans le cloud, le Chromium du système reste bloqué : on prend d'abord la version
# « sans fenêtre » de Playwright, lancée sans bac à sable (la routine tourne en root).
import glob  # noqa: E402
EDGE = os.environ.get("NAVIGATEUR") or next(
    (c for c in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                 *sorted(glob.glob("/opt/pw-browsers/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")),
                 shutil.which("chromium"), shutil.which("chromium-browser"),
                 shutil.which("google-chrome"), shutil.which("google-chrome-stable"))
     if c and Path(c).exists()),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
SANS_BAC = [] if os.name == "nt" else ["--no-sandbox"]
MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
        "septembre", "octobre", "novembre", "décembre"]

# Pages du site mises en avant sous chaque modèle (maillage interne).
OUTILS = [
    ("Générer un contrat avec l'IA", f"{SITE}/outil-generation-contrat-ia/"),
    ("Signature électronique en ligne", f"{SITE}/signature-electronique-en-ligne/"),
    ("Analyse et révision de contrat", f"{SITE}/revision-contractuelle-ia/"),
]

e = html.escape


def date_fr(iso):
    d = date.fromisoformat(iso)
    return f"{d.day} {MOIS[d.month - 1]} {d.year}"


def lire_etat():
    return json.loads(ETAT.read_text(encoding="utf-8")) if ETAT.exists() else {"modeles": {}}


def ecrire_etat(etat):
    ETAT.write_text(json.dumps(etat, ensure_ascii=False, indent=2), encoding="utf-8")


# Bouton « Personnaliser » : formulaire de génération de l'application, pré-réglé sur le
# modèle. `doc` = nom du contrat sans article ni préposition (ex. « pacte-associes »).
APP_GENERATION = "https://app.lumenjuris.com/contrat-generation?section=scratch&titre={}&de=hub"
MOTS_VIDES = {"de", "d", "du", "des", "la", "le", "les", "l", "a", "au", "aux", "et", "en", "pour", "sur", "un", "une"}


def doc_app(slug):
    return "-".join(m for m in slug.split("-") if m not in MOTS_VIDES)


def fiche(slug):
    f = json.loads((DOSSIER / slug / "fiche.json").read_text(encoding="utf-8"))
    f["url"] = f"{BIBLIO_URL}{slug}/"
    titre = f["personnaliser"].get("titre") or re.sub(r"^contrat (de |d')?", "", f["nom_court"], flags=re.I)
    f["personnaliser"]["url"] = APP_GENERATION.format(urllib.parse.quote_plus(titre.lower().replace("'", " ")))
    return f


def tous_les_slugs():
    return sorted(p.name for p in DOSSIER.iterdir() if (p / "fiche.json").exists())


# --------------------------------------------------------------------------
# Texte du contrat
# --------------------------------------------------------------------------

def blocs_modele(slug):
    """Découpe modele.txt en blocs (type, texte)."""
    blocs, para = [], []

    def fin_para():
        if para:
            blocs.append(("p", " ".join(para)))
            para.clear()

    for ligne in (DOSSIER / slug / "modele.txt").read_text(encoding="utf-8").splitlines():
        l = ligne.strip()
        if not l:
            fin_para()
            continue
        for prefixe, typ in (("### ", "h3"), ("## ", "h2"), ("# ", "h1"), ("- ", "li"), ("> ", "note")):
            if l.startswith(prefixe):
                fin_para()
                blocs.append((typ, l[len(prefixe):]))
                break
        else:
            para.append(l)
    fin_para()
    return blocs


def champs_html(texte):
    """Échappe et surligne les [champs à compléter]."""
    return re.sub(r"\[([^\]]*)\]", r'<mark class="lj-champ">[\1]</mark>', e(texte, quote=False))


def modele_html(blocs, niveau=3):
    """Texte du contrat en HTML. `niveau` = balise des articles (h3 dans la page)."""
    out, liste = [], False
    for typ, txt in blocs:
        if typ != "li" and liste:
            out.append("</ul>")
            liste = False
        if typ == "h1":
            out.append(f'<p class="lj-c-titre">{champs_html(txt)}</p>')
        elif typ == "h2":
            out.append(f"<h{niveau}>{champs_html(txt)}</h{niveau}>")
        elif typ == "h3":
            out.append(f"<h{niveau + 1}>{champs_html(txt)}</h{niveau + 1}>")
        elif typ == "li":
            if not liste:
                out.append("<ul>")
                liste = True
            out.append(f"<li>{champs_html(txt)}</li>")
        elif typ == "note":
            out.append(f'<p class="lj-c-note">{champs_html(txt)}</p>')
        else:
            out.append(f"<p>{champs_html(txt)}</p>")
    if liste:
        out.append("</ul>")
    return "\n".join(out)


def construire_docx(f, blocs, chemin):
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_COLOR_INDEX
    from docx.shared import Pt, RGBColor, Cm

    doc = Document()
    for s in doc.sections:
        s.left_margin = s.right_margin = Cm(2.3)
        s.top_margin = s.bottom_margin = Cm(2)
        pied = s.footer.paragraphs[0]
        pied.text = f"Modèle Lumen Juris – {f['url']}"
        pied.runs[0].font.size = Pt(8)
        pied.runs[0].font.color.rgb = RGBColor(0x83, 0x81, 0x81)
    style = doc.styles["Normal"]
    style.font.name = "Calibri"
    style.font.size = Pt(11)

    def remplir(par, texte, italique=False, gras=False, couleur=None):
        for i, morceau in enumerate(re.split(r"(\[[^\]]*\])", texte)):
            if not morceau:
                continue
            r = par.add_run(morceau)
            r.italic, r.bold = italique, gras
            if couleur:
                r.font.color.rgb = couleur
            if i % 2:
                r.font.highlight_color = WD_COLOR_INDEX.YELLOW

    for typ, txt in blocs:
        if typ == "h1":
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            remplir(p, txt, gras=True)
            p.runs[0].font.size = Pt(18)
        elif typ in ("h2", "h3"):
            p = doc.add_heading(level=1 if typ == "h2" else 2)
            remplir(p, txt, couleur=RGBColor(0x0A, 0x25, 0x40))
        elif typ == "li":
            remplir(doc.add_paragraph(style="List Bullet"), txt)
        elif typ == "note":
            remplir(doc.add_paragraph(), txt, italique=True, couleur=RGBColor(0x55, 0x55, 0x55))
        else:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            remplir(p, txt)
    doc.core_properties.title = f"Modèle de {f['nom_court']}"
    doc.core_properties.author = "Lumen Juris"
    doc.save(chemin)


def construire_pdf(f, blocs, chemin):
    page = f"""<!doctype html><html lang="fr"><meta charset="utf-8">
<title>Modèle de {e(f['nom_court'])} – Lumen Juris</title>
<style>
@page {{ size: A4; margin: 20mm 22mm; }}
body {{ font: 10.5pt/1.55 Calibri, Arial, sans-serif; color: #111; }}
.lj-c-titre {{ text-align: center; font-size: 18pt; font-weight: bold; margin: 0 0 18pt; }}
h3 {{ font-size: 12pt; color: #0A2540; margin: 16pt 0 6pt; page-break-after: avoid; }}
h4 {{ font-size: 11pt; color: #0A2540; margin: 10pt 0 4pt; page-break-after: avoid; }}
p {{ margin: 0 0 7pt; text-align: justify; }}
.lj-c-note {{ font-style: italic; color: #555; border-left: 3px solid #3E89F7; padding-left: 8pt; }}
mark {{ background: #FFF3A3; }}
.pied {{ margin-top: 24pt; font-size: 8pt; color: #838181; }}
</style>
{modele_html(blocs)}
<p class="pied">Modèle Lumen Juris – {e(f['url'])}</p></html>"""
    source = chemin.with_suffix(".imprimer.html")
    source.write_text(page, encoding="utf-8")
    # Profil séparé : sinon Edge, s'il est déjà ouvert, confie la tâche à la
    # fenêtre existante et ne produit aucun fichier.
    import tempfile
    profil = Path(tempfile.mkdtemp(prefix="lj-edge-"))
    subprocess.run([EDGE, "--headless=new", *SANS_BAC, "--disable-gpu", "--no-pdf-header-footer",
                    f"--user-data-dir={profil}", f"--print-to-pdf={chemin}", source.as_uri()],
                   check=True, capture_output=True, timeout=120)
    source.unlink()
    import shutil
    shutil.rmtree(profil, ignore_errors=True)
    if not chemin.exists():
        sys.exit(f"PDF non produit : {chemin}")


# --------------------------------------------------------------------------
# Page WordPress
# --------------------------------------------------------------------------

CSS = """
.lj-ariane{font-size:13px;margin:0 0 1.2em}
.lj-ariane p{margin:0}.lj-ariane .separator{margin:0 6px;color:#838181}
.lj-ariane a{color:#354F99;text-decoration:none}.lj-ariane a:hover{text-decoration:underline}
.lj-ariane ol{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:4px}
.lj-ariane li+li::before{content:"›";margin:0 6px;color:#838181}
.lj-ariane a{color:#354F99;text-decoration:none}.lj-ariane a:hover{text-decoration:underline}
.lj-ariane [aria-current]{color:#555}
.lj-mc{--lj-bleu:#354F99;--lj-vif:#3E89F7;--lj-nuit:#0A2540;--lj-pale:#EEF3FF;--lj-trait:#E5E7EB;
 color:#1f2937;line-height:1.7;font-size:15px;max-width:760px;margin:0 auto 72px}
.page-header .entry-title{max-width:760px;margin-left:auto;margin-right:auto}
.lj-mc h2{color:var(--lj-nuit);font-size:1.45em;line-height:1.3;margin:2.2em 0 .6em}
.lj-mc a{color:var(--lj-bleu)}
.lj-chapo{font-size:1.08em;margin:0 0 1.2em}
.lj-maj{font-size:13px;color:#6b7280;margin:-.4em 0 .3em}
.lj-btns{display:flex;flex-wrap:wrap;gap:10px}
.lj-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:10px;font-weight:700;
 font-size:16px;text-decoration:none!important;line-height:1.2;border:2px solid var(--lj-bleu)}
.lj-btn-plein{background:var(--lj-bleu);color:#fff!important}.lj-btn-plein:hover{background:var(--lj-nuit);border-color:var(--lj-nuit)}
.lj-btn-vide{background:#fff;color:var(--lj-bleu)!important}.lj-btn-vide:hover{background:var(--lj-pale)}
.lj-btn-ia{background:linear-gradient(135deg,#3E89F7,#354F99);color:#fff!important;border-color:transparent}
.lj-modele{border:1px solid #A4BFDF;border-radius:16px;margin:.6em 0 1.6em;background:#fff;
 box-shadow:0 10px 30px rgba(10,37,64,.08);overflow:hidden}
.lj-modele-tete{background:var(--lj-nuit);color:#fff;padding:16px 22px;display:flex;flex-wrap:wrap;
 justify-content:space-between;align-items:center;gap:12px}
.lj-modele-tete .lj-btn{width:190px;height:42px;box-sizing:border-box;justify-content:center;padding:0 12px;font-size:14px;white-space:nowrap}.lj-dl{display:block}
.lj-ico{width:18px;height:18px;flex:0 0 18px}
.lj-dl{position:relative}
.lj-dl summary{list-style:none;cursor:pointer}.lj-dl summary::-webkit-details-marker{display:none}
.lj-dl-menu{position:absolute;right:0;top:calc(100% + 6px);z-index:5;background:#fff;border:1px solid var(--lj-trait);
 border-radius:10px;box-shadow:0 10px 30px rgba(10,37,64,.15);min-width:210px;padding:6px}
.lj-dl-menu a{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;
 color:var(--lj-nuit)!important;text-decoration:none;font-weight:600;font-size:14px}
.lj-dl-menu a:hover{background:var(--lj-pale)}.lj-dl-menu small{color:#6b7280;font-weight:400}
.lj-modele-texte{max-height:620px;overflow:auto;padding:26px 30px;font-family:Georgia,'Times New Roman',serif;
 font-size:14px;line-height:1.65;background:#fcfcfd}
.lj-modele-texte:focus-visible{outline:3px solid var(--lj-vif);outline-offset:-3px}
.lj-modele-texte h3{font-family:inherit;font-size:1.05em;color:var(--lj-nuit);margin:1.5em 0 .4em;text-transform:none}
.lj-modele-texte h4{font-family:inherit;font-size:1em;color:var(--lj-nuit);margin:1em 0 .3em}
.lj-modele-texte p{margin:0 0 .7em;text-align:justify}
.lj-c-titre{text-align:center!important;font-size:1.35em;font-weight:700;letter-spacing:.04em;color:var(--lj-nuit)}
.lj-c-note{font-style:italic;color:#4b5563;border-left:3px solid var(--lj-vif);padding:4px 0 4px 12px;
 background:var(--lj-pale);text-align:left!important}
.lj-champ{background:#FFF3A3;color:inherit;padding:0 2px;border-radius:3px}
.lj-modele-pied{border-top:1px solid var(--lj-trait);padding:12px 22px;background:#fff}
.lj-modele-pied p{margin:0;font-size:13px;color:#4b5563}
.lj-sommaire{border-left:3px solid var(--lj-vif);padding:4px 0 4px 16px;margin:0 0 1.6em;font-size:15px}
.lj-sommaire p{margin:0 0 4px;font-weight:700;color:var(--lj-nuit)}
.lj-sommaire ol{margin:0;padding-left:20px}
.lj-table-wrap{overflow-x:auto}
.lj-table{border-collapse:collapse;width:100%;font-size:15px}
.lj-table th,.lj-table td{border:1px solid var(--lj-trait);padding:10px 12px;text-align:left;vertical-align:top}
.lj-table thead th{background:var(--lj-nuit);color:#fff}.lj-table tbody th{background:var(--lj-pale)}
.lj-clauses li{margin-bottom:8px}
.lj-etapes{counter-reset:etape;list-style:none;padding:0}
.lj-etapes li{counter-increment:etape;position:relative;padding:0 0 14px 52px}
.lj-etapes li::before{content:counter(etape);position:absolute;left:0;top:0;width:36px;height:36px;border-radius:50%;
 background:var(--lj-bleu);color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
.lj-etapes strong{display:block;color:var(--lj-nuit)}
.lj-faq details{border:1px solid var(--lj-trait);border-radius:12px;background:#fff;margin:0 0 10px}
.lj-faq details[open]{border-color:#A4BFDF}
.lj-faq summary{cursor:pointer;padding:14px 18px;font-weight:600;color:var(--lj-nuit)}
.lj-faq details>div{padding:0 18px 14px}
.lj-auteur{display:flex;gap:18px;align-items:flex-start;border:1px solid var(--lj-trait);border-radius:16px;
 padding:20px 22px;margin:2.4em 0}
.lj-auteur h2{font-size:1.1em!important;margin:0 0 2px!important}
.lj-avatar{flex:0 0 56px;height:56px;border-radius:50%;background:var(--lj-bleu);color:#fff;font-weight:700;
 font-size:20px;display:flex;align-items:center;justify-content:center}
.lj-auteur p{margin:0 0 6px;font-size:14px}.lj-auteur .lj-role{color:#6b7280}
.lj-sources{font-size:14px;color:#4b5563}
.lj-sources ul{padding-left:20px}
.lj-cartes{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;padding:0;list-style:none}
.lj-cartes li{border:1px solid var(--lj-trait);border-radius:12px;padding:16px 18px;background:#fff}
.lj-cartes a{font-weight:700;text-decoration:none}.lj-cartes p{margin:6px 0 0;font-size:14px;color:#4b5563}
@media (max-width:640px){.lj-mc{font-size:16px}.lj-modele-texte{padding:18px;max-height:480px}
 .lj-modele-tete .lj-btn{width:150px}.lj-auteur{flex-direction:column}}
"""


# Fil d'Ariane de Rank Math (affichage + micro-données BreadcrumbList générées par le plugin).
FIL_ARIANE = '<div class="lj-ariane">[rank_math_breadcrumb]</div>'


# Style compacté (espaces et retours à la ligne retirés) : même rendu, moins d'octets.
CSS_MIN = re.sub(r"\s*([{};:,>])\s*", r"\1", re.sub(r"\s+", " ", CSS)).replace(";}", "}").strip()


def ariane(elements):
    lis = []
    for nom, url in elements:
        lis.append(f'<li><a href="{e(url)}">{e(nom)}</a></li>' if url else f'<li aria-current="page">{e(nom)}</li>')
    return f'<nav class="lj-ariane" aria-label="Fil d\'Ariane"><ol>{"".join(lis)}</ol></nav>'


def fichiers_telechargement(etat_modele):
    return etat_modele.get("fichiers", {}) if etat_modele else {}


def modeles_associes(slug, etat, publics_seulement):
    """Autres modèles, même catégorie d'abord."""
    f0 = fiche(slug)
    autres = []
    for s in tous_les_slugs():
        if s == slug:
            continue
        em = etat["modeles"].get(s, {})
        if publics_seulement and em.get("statut") != "publish":
            continue
        fs = fiche(s)
        autres.append((fs["categorie"] != f0["categorie"], fs["nom"], fs))
    return [x[2] for x in sorted(autres, key=lambda x: (x[0], x[1]))][:6]


def page_modele(slug, etat, publics_seulement=True):
    f = fiche(slug)
    em = etat["modeles"].get(slug, {})
    fich = fichiers_telechargement(em)
    blocs = blocs_modele(slug)
    rel = f["relecture"]
    u = f["url"]
    article = (DOSSIER / slug / "article.html").read_text(encoding="utf-8")
    sommaire = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', article)
    sommaire = [("modele", f"Le modèle de {f['nom_court']}")] + sommaire + [
        ("etapes", "Remplir le modèle en 5 étapes"), ("faq", "Questions fréquentes")]
    docx, pdf = fich.get("docx", {}), fich.get("pdf", {})
    perso = f["personnaliser"]
    ico_dl = ('<svg class="lj-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/>'
              '<path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>')
    ico_ia = ('<svg class="lj-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/>'
              '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>')
    actions = (
        f'<a class="lj-btn lj-btn-plein" href="{e(perso["url"])}" rel="nofollow">{ico_ia}Personnaliser</a>'
        f'<details class="lj-dl"><summary class="lj-btn lj-btn-plein">{ico_dl}Télécharger</summary>'
        f'<div class="lj-dl-menu">'
        f'<a href="{e(docx.get("url", "#"))}" download>Word <small>.docx · {e(docx.get("taille", ""))}</small></a>'
        f'<a href="{e(pdf.get("url", "#"))}" download>PDF <small>.pdf · {e(pdf.get("taille", ""))}</small></a>'
        f'</div></details>')

    associes = modeles_associes(slug, etat, publics_seulement)
    cartes = "".join(
        f'<li><a href="{e(a["url"])}">Modèle de {e(a["nom_court"])}</a><p>{e(a["categorie"])}</p></li>'
        for a in associes)
    cartes += "".join(f'<li><a href="{e(url)}">{e(nom)}</a><p>Outil Lumen Juris</p></li>' for nom, url in OUTILS)

    h = [f"<style>{CSS_MIN}</style>",
         '<div class="lj-mc">',
         f'<p class="lj-maj">Mis à jour le <time datetime="{f["date_mise_a_jour"]}">{date_fr(f["date_mise_a_jour"])}</time></p>',
         FIL_ARIANE,
         f'<p class="lj-chapo">{e(f["chapo"])}</p>',
         '<nav class="lj-sommaire" aria-label="Sommaire"><p>Sommaire</p><ol>'
         + "".join(f'<li><a href="#{i}">{t}</a></li>' for i, t in sommaire) + "</ol></nav>",
         f'<h2 id="modele">Le modèle de {e(f["nom_court"])}</h2>'
         f'<section class="lj-modele" aria-labelledby="modele">'
         f'<div class="lj-modele-tete">{actions}</div>'
         f'<div class="lj-modele-texte" tabindex="0" role="region" aria-label="Texte du modèle">{modele_html(blocs)}</div>'
         f'<div class="lj-modele-pied"><p>Gratuit, sans inscription. Les passages <mark class="lj-champ">[entre crochets]</mark>'
         f' sont à compléter.</p></div></section>',
         article,
         f'<h2 id="etapes">Comment remplir le modèle en 5 étapes</h2><ol class="lj-etapes">'
         + "".join(f'<li id="etape-{i}"><strong>{e(n)}</strong>{e(t)}</li>' for i, (n, t) in enumerate(f["etapes"], 1))
         + "</ol>",
         '<h2 id="faq">Questions fréquentes</h2><div class="lj-faq">'
         + "".join(f"<details><summary>{e(q)}</summary><div><p>{e(r)}</p></div></details>" for q, r in f["faq"])
         + "</div>",
         f'<section class="lj-auteur" aria-labelledby="auteur">'
         '<div class="lj-avatar" aria-hidden="true"><svg class="lj-ico" style="width:28px;height:28px" viewBox="0 0 24 24" '
         'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/>'
         '<path d="M5 21h14"/><path d="M3 7h18"/><path d="m6 7-3 7a3 3 0 0 0 6 0Z"/><path d="m18 7-3 7a3 3 0 0 0 6 0Z"/></svg></div>'
         f'<div><h2 id="auteur">{e(rel["nom"])}</h2><p class="lj-role">{e(rel["fonction"])}</p>'
         f'<p>{e(rel["presentation"])}</p><p><a href="{e(rel["url_profil"])}">Découvrir l\'équipe Lumen Juris</a></p>'
         f'<p class="lj-role">Ce modèle est fourni à titre informatif. Il ne remplace pas un conseil personnalisé adapté à votre situation.</p></div></section>',
         '<section class="lj-sources" aria-label="Sources"><h2>Sources</h2><ul>'
         + "".join(f'<li><a href="{e(url)}" rel="noopener" target="_blank">{e(nom)}</a></li>' for nom, url in f["sources"])
         + "</ul></section>",
         f'<section aria-labelledby="associes"><h2 id="associes">Modèles associés</h2><ul class="lj-cartes">{cartes}</ul></section>',
         "</div>",
         f'<script type="application/ld+json">{json.dumps(schema_modele(f, blocs, fich, associes, em.get("image")), ensure_ascii=False, separators=(",", ":"))}</script>']
    return "<!-- wp:html -->\n" + "\n".join(h) + "\n<!-- /wp:html -->"


def schema_modele(f, blocs, fich, associes, image=None):
    u, rel = f["url"], f["relecture"]
    personne_id = f"{SITE}/#equipe-juridique"
    mots = sum(len(t.split()) for _, t in blocs)
    encodages = [{"@type": "MediaObject", "name": f"Modèle de {f['nom_court']} ({fmt})",
                  "contentUrl": fich[k]["url"], "encodingFormat": mime, "contentSize": fich[k].get("taille")}
                 for k, fmt, mime in (("docx", "Word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                                      ("pdf", "PDF", "application/pdf")) if k in fich]
    page = {
        "@type": "WebPage", "@id": f"{u}#webpage", "url": u, "name": f["titre_seo"],
        "description": f["meta_description"], "inLanguage": "fr-FR",
        "isPartOf": {"@id": f"{SITE}/#website"}, "breadcrumb": {"@id": f"{u}#breadcrumb"},
        "mainEntity": {"@id": f"{u}#modele"}, "about": {"@id": f"{u}#sujet"},
        "datePublished": f["date_publication"], "dateModified": f["date_mise_a_jour"],
        "hasPart": [{"@id": f"{u}#article"}, {"@id": f"{u}#faq"}, {"@id": f"{u}#howto"}],
        "speakable": {"@type": "SpeakableSpecification", "cssSelector": [".lj-chapo"]},
        "relatedLink": [a["url"] for a in associes] + [url for _, url in OUTILS],
        "publisher": ORG,
    }
    if rel["valide"]:
        page["reviewedBy"] = {"@id": personne_id}
        page["lastReviewed"] = rel["date_validation"]
    modele = {
        "@type": "DigitalDocument", "@id": f"{u}#modele", "url": u,
        "name": f"Modèle de {f['nom_court']}", "headline": f["titre_h1"],
        "alternateName": [f"Exemple de {f['nom_court']}", f"Trame de {f['nom_court']}"],
        "description": f["chapo"],
        "genre": "Modèle de contrat", "inLanguage": "fr-FR",
        "about": {"@id": f"{u}#sujet"}, "mainEntityOfPage": {"@id": f"{u}#webpage"},
        "isPartOf": {"@id": f"{BIBLIO_URL}#bibliotheque"},
        "author": {"@id": personne_id}, "publisher": ORG, "copyrightHolder": ORG,
        "copyrightYear": int(f["date_publication"][:4]),
        "datePublished": f["date_publication"], "dateModified": f["date_mise_a_jour"],
        "wordCount": mots, "isAccessibleForFree": f["gratuit"],
        "audience": {"@type": "BusinessAudience", "audienceType": "Associés, fondateurs et dirigeants de sociétés"},
        "spatialCoverage": {"@type": "Country", "name": "France"},
        "encoding": encodages,
        "citation": [{"@type": "Legislation", "name": nom, "url": url, "legislationJurisdiction": "FR",
                      "inLanguage": "fr-FR"} for nom, url in f["sources"]],
        "potentialAction": [
            *[{"@type": "DownloadAction", "target": x["contentUrl"]} for x in encodages],
            {"@type": "CreateAction", "name": f"Personnaliser le {f['nom_court']} en ligne",
             "target": {"@type": "EntryPoint", "urlTemplate": f["personnaliser"]["url"]},
             "agent": ORG}],
    }
    article = {
        "@type": "Article", "@id": f"{u}#article", "headline": f["titre_h1"], "description": f["meta_description"],
        "inLanguage": "fr-FR", "author": {"@id": personne_id}, "publisher": ORG,
        "datePublished": f["date_publication"], "dateModified": f["date_mise_a_jour"],
        "mainEntityOfPage": {"@id": f"{u}#webpage"}, "isPartOf": {"@id": f"{u}#webpage"},
        "about": {"@id": f"{u}#sujet"}, "articleSection": "Modèles de contrat",
        "keywords": ", ".join([f["mot_cle"]] + f["mots_cles_secondaires"]),
        "isAccessibleForFree": True,
    }
    if image:
        img = {"@type": "ImageObject", "@id": f"{u}#image", "url": image["url"], "contentUrl": image["url"],
               "width": 1200, "height": 630, "caption": f"Modèle de {f['nom_court']} – Lumen Juris",
               "inLanguage": "fr-FR"}
        page["primaryImageOfPage"] = {"@id": f"{u}#image"}
        page["image"] = {"@id": f"{u}#image"}
        article["image"] = {"@id": f"{u}#image"}
        modele["image"] = {"@id": f"{u}#image"}
        modele["thumbnailUrl"] = image["url"]
    if f["gratuit"]:
        modele["offers"] = {"@type": "Offer", "price": "0", "priceCurrency": "EUR",
                            "availability": "https://schema.org/InStock", "url": u, "seller": ORG}
    graphe = [
        page, modele, article,
        {"@type": "Thing", "@id": f"{u}#sujet", "name": f["nom"],
         "alternateName": [m for m in f["mots_cles_secondaires"] if not m.startswith(("modèle", "exemple"))]},
        {"@type": "HowTo", "@id": f"{u}#howto", "name": f"Comment remplir le modèle de {f['nom_court']}",
         "inLanguage": "fr-FR", "tool": [{"@type": "HowToTool", "name": "Traitement de texte (Word, LibreOffice, Google Docs)"}],
         "step": [{"@type": "HowToStep", "position": i, "name": n, "text": t, "url": f"{u}#etape-{i}"}
                  for i, (n, t) in enumerate(f["etapes"], 1)]},
        {"@type": "FAQPage", "@id": f"{u}#faq", "url": u, "inLanguage": "fr-FR",
         "mainEntity": [{"@type": "Question", "name": q,
                         "acceptedAnswer": {"@type": "Answer", "text": r}} for q, r in f["faq"]]},
    ]
    # Auteur : l'équipe juridique (service de l'organisation), sans personne nommée.
    graphe.append({"@type": "Organization", "@id": personne_id, "name": rel["nom"],
                   "description": rel["presentation"], "url": rel["url_profil"],
                   "parentOrganization": ORG, "knowsAbout": rel["domaines"]})
    if image:
        graphe.append(img)
    return {"@context": "https://schema.org", "@graph": graphe}


def page_bibliotheque(etat, publics_seulement=True):
    slugs = [s for s in tous_les_slugs()
             if not publics_seulement or etat["modeles"].get(s, {}).get("statut") == "publish"]
    par_cat = {}
    for s in slugs:
        f = fiche(s)
        par_cat.setdefault(f["categorie"], []).append(f)
    sections = []
    for cat in sorted(par_cat):
        cartes = "".join(
            f'<li><a href="{e(f["url"])}">Modèle de {e(f["nom_court"])}</a><p>{e(f["meta_description"][:140])}…</p></li>'
            for f in sorted(par_cat[cat], key=lambda x: x["nom"]))
        sections.append(f'<h2>{e(cat)}</h2><ul class="lj-cartes">{cartes}</ul>')
    toutes = [fiche(s) for s in slugs]
    schema = {"@context": "https://schema.org", "@graph": [
        {"@type": "CollectionPage", "@id": f"{BIBLIO_URL}#bibliotheque", "url": BIBLIO_URL,
         "name": BIBLIO_TITRE, "inLanguage": "fr-FR", "isPartOf": {"@id": f"{SITE}/#website"},
         "publisher": ORG, "mainEntity": {"@id": f"{BIBLIO_URL}#liste"},
         "breadcrumb": {"@id": f"{BIBLIO_URL}#breadcrumb"}},
        {"@type": "ItemList", "@id": f"{BIBLIO_URL}#liste", "numberOfItems": len(toutes),
         "itemListElement": [{"@type": "ListItem", "position": i, "url": f["url"], "name": f"Modèle de {f['nom_court']}"}
                             for i, f in enumerate(toutes, 1)]}]}
    h = [f"<style>{CSS_MIN}</style>",
         '<div class="lj-mc">',
         FIL_ARIANE,
         '<p class="lj-chapo">Des modèles de contrat gratuits, rédigés en français clair et relus par une juriste. '
         'Téléchargez-les en Word ou en PDF, ou personnalisez-les en ligne en répondant à quelques questions.</p>',
         *sections,
         "</div>",
         f'<script type="application/ld+json">{json.dumps(schema, ensure_ascii=False, separators=(",", ":"))}</script>']
    return "<!-- wp:html -->\n" + "\n".join(h) + "\n<!-- /wp:html -->"


# --------------------------------------------------------------------------
# Construction locale
# --------------------------------------------------------------------------

def construire_image(f, chemin):
    """Visuel 1200 x 630 : vignette Google, partage sur les réseaux, micro-données."""
    page = f"""<!doctype html><html lang="fr"><meta charset="utf-8"><style>
html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}
body{{background:linear-gradient(135deg,#0A2540 0%,#354F99 100%);font-family:'Segoe UI',Arial,sans-serif;color:#fff;
 display:flex;align-items:center;justify-content:space-between;padding:0 80px;box-sizing:border-box}}
.g{{max-width:560px}}.m{{font-size:22px;letter-spacing:.14em;text-transform:uppercase;color:#A4BFDF;margin:0 0 18px}}
h1{{font-size:58px;line-height:1.1;margin:0 0 26px}}
.b{{display:flex;gap:12px}}.b span{{background:rgba(255,255,255,.14);border-radius:999px;padding:10px 20px;font-size:22px}}
.l{{position:absolute;left:80px;bottom:44px;font-size:24px;font-weight:700}}
.f{{width:360px;height:470px;background:#fff;border-radius:10px;box-shadow:0 30px 60px rgba(0,0,0,.35);
 transform:rotate(3deg);padding:38px 34px;box-sizing:border-box;color:#0A2540;font-family:Georgia,serif}}
.f p{{margin:0 0 18px;text-align:center;font-weight:700;font-size:20px;letter-spacing:.05em}}
.f i{{display:block;height:10px;border-radius:5px;background:#E5E7EB;margin:0 0 13px}}
.f i.j{{background:#FFF3A3;width:55%}}.f i.c{{width:80%}}.f b{{display:block;height:12px;width:45%;background:#354F99;
 border-radius:6px;margin:22px 0 14px;opacity:.8}}
</style><body><div class="g"><p class="m">Modèle de contrat gratuit</p><h1>{e(f['nom'])}</h1>
<div class="b"><span>Word</span><span>PDF</span><span>Personnalisable</span></div></div>
<div class="f"><p>{e(f['nom'].upper())}</p><i></i><i class="j"></i><i class="c"></i><i></i><b></b><i></i><i class="c"></i>
<i class="j"></i><i></i><b></b><i></i><i class="c"></i><i></i></div>
<div class="l">Lumen Juris</div></body></html>"""
    import tempfile
    import shutil
    source = chemin.with_suffix(".image.html")
    source.write_text(page, encoding="utf-8")
    chemin.unlink(missing_ok=True)
    profil = Path(tempfile.mkdtemp(prefix="lj-edge-"))
    subprocess.run([EDGE, "--headless=new", *SANS_BAC, "--disable-gpu", "--hide-scrollbars", "--window-size=1200,630",
                    f"--user-data-dir={profil}", f"--screenshot={chemin}", source.as_uri()],
                   check=True, capture_output=True, timeout=120)
    import time
    for _ in range(30):  # Edge peut rendre la main avant d'avoir écrit l'image
        if chemin.exists() and chemin.stat().st_size > 0:
            break
        time.sleep(0.5)
    time.sleep(1)
    source.unlink()
    shutil.rmtree(profil, ignore_errors=True)
    if not chemin.exists():
        sys.exit(f"Image non produite : {chemin}")


def construire(slug):
    f = fiche(slug)
    blocs = blocs_modele(slug)
    sortie = DOSSIER / slug / "sortie"
    sortie.mkdir(exist_ok=True)
    construire_docx(f, blocs, sortie / f"{f['fichier_base']}.docx")
    construire_pdf(f, blocs, sortie / f"{f['fichier_base']}.pdf")
    construire_image(f, sortie / f"{f['fichier_base']}.png")
    if "<table" not in (DOSSIER / slug / "article.html").read_text(encoding="utf-8"):
        sys.exit("Refus : article.html doit contenir au moins un tableau (<table>).")
    restants = [t for typ, t in blocs if "TODO" in t]
    if restants:
        print("  ! TODO restant dans le modèle :", restants)
    print(f"Construit : {sortie}")
    return sortie


def apercu(slug, etat):
    """Page complète en local, dans l'habillage réel du site (en-tête, pied de page)."""
    f = fiche(slug)
    em = dict(etat["modeles"].get(slug, {}))
    sortie = DOSSIER / slug / "sortie"
    if not em.get("fichiers"):
        em["fichiers"] = {k: {"url": f"{f['fichier_base']}.{k}"} for k in ("docx", "pdf")}
    etat2 = {"modeles": {**etat["modeles"], slug: em}}
    contenu = page_modele(slug, etat2, publics_seulement=False)
    coquille = wp_api.req(f"{SITE}/faq/", auth=False)
    coquille = re.sub(r'<h1 class="entry-title">.*?</h1>', f'<h1 class="entry-title">{e(f["titre_h1"])}</h1>', coquille, flags=re.S)
    debut = coquille.index('<div class="page-content">') + len('<div class="page-content">')
    fin = coquille.index("</main>")
    corps = contenu.replace("<!-- wp:html -->", "").replace("<!-- /wp:html -->", "")
    corps = corps.replace("[rank_math_breadcrumb]", '<nav class="rank-math-breadcrumb"><p>'
                          f'<a href="{PARENT_URL}">{PARENT_TITRE}</a><span class="separator"> | </span>'
                          f'<a href="{BIBLIO_URL}">{BIBLIO_TITRE}</a><span class="separator"> | </span>'
                          f'<span class="last">{e(f["nom"])}</span></p></nav>')
    page = coquille[:debut] + corps + "</div>\n" + coquille[fin:]
    page = re.sub(r"<title>.*?</title>", f"<title>{e(f['titre_seo'])}</title>", page, flags=re.S)
    (sortie / "apercu.html").write_text(page, encoding="utf-8")
    print(f"Aperçu : {sortie / 'apercu.html'}")


# --------------------------------------------------------------------------
# WordPress
# --------------------------------------------------------------------------

_ordre = None  # ordre en cours d'écriture (publication par le serveur)


def ordre_ouvrir(action, slug):
    global _ordre
    if DIFFERE:
        _ordre = {"id": f"{datetime.now():%Y%m%d-%H%M%S}-{action}-{slug}",
                  "cree": f"{datetime.now():%Y-%m-%d %H:%M:%S}", "description": f"{action} {slug}",
                  "operations": []}


def ordre_fermer(etat):
    global _ordre
    if _ordre is None:
        return
    ORDRES.mkdir(exist_ok=True)
    chemin = ORDRES / f"{_ordre['id']}.json"
    chemin.write_text(json.dumps(_ordre, ensure_ascii=False, indent=1), encoding="utf-8")
    etat.setdefault("ordres_en_attente", []).append(_ordre["id"])
    ecrire_etat(etat)
    print(f"  ordre enregistré : {chemin.relative_to(DEPOT).as_posix()} ({len(_ordre['operations'])} opérations)")
    print("  -> le serveur o2switch l'exécutera à son prochain passage, une fois le travail envoyé sur GitHub (git push).")
    _ordre = None


def repere(ref, champ):
    return "{{%s.%s.%s}}" % (_ordre["id"], ref, champ)


def operation(op):
    op = {"ref": f"o{len(_ordre['operations']) + 1}", **op}
    _ordre["operations"].append(op)
    return op["ref"]


def api(chemin, data=None, method=None):
    if _ordre is not None and method in ("POST", "DELETE"):
        ref = operation({"type": "rest", "methode": method, "route": f"/{chemin}", "donnees": data,
                         **({"facultatif": True} if chemin.startswith("elementor/") else {})})
        m = re.fullmatch(r"wp/v2/pages/(\S+)", chemin)
        ident = (int(m.group(1)) if m.group(1).isdigit() else m.group(1)) if m else repere(ref, "id")
        return {"id": ident, "status": (data or {}).get("status") or repere(ref, "status"), "link": repere(ref, "link")}
    return json.loads(wp_api.req(f"{SITE}/wp-json/{chemin}", data=data, method=method))


def envoyer_media(chemin):
    contenu = chemin.read_bytes()
    mime = {".pdf": "application/pdf", ".png": "image/png",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}[chemin.suffix]
    if _ordre is not None:
        ref = operation({"type": "media", "fichier": chemin.relative_to(DEPOT).as_posix(), "mime": mime,
                         "empreinte_fichier": hashlib.sha256(contenu).hexdigest()})
        return {"id": repere(ref, "id"), "url": repere(ref, "source_url"),
                "taille": f"{len(contenu) // 1024} Ko", "empreinte": hashlib.sha256(contenu).hexdigest()}
    r = urllib.request.Request(
        f"{SITE}/wp-json/wp/v2/media", data=contenu, method="POST",
        headers={"Authorization": f"Basic {wp_api.TOKEN}", "User-Agent": wp_api.UA, "Content-Type": mime,
                 "Content-Disposition": f'attachment; filename="{chemin.name}"'})
    with urllib.request.urlopen(r, timeout=120) as resp:
        j = json.loads(resp.read().decode("utf-8"))
    return {"id": j["id"], "url": j["source_url"], "taille": f"{len(contenu) // 1024} Ko",
            "empreinte": hashlib.sha256(contenu).hexdigest()}


def sauvegarder(page_id, nom):
    if _ordre is not None:  # le serveur sauvegarde aussi chaque page avant de la modifier
        if not isinstance(page_id, int):
            return Path("(sauvegarde faite par le serveur)")
        try:
            return _sauvegarder(page_id, nom)
        except Exception as err:
            return Path(f"(lecture impossible : {err} ; sauvegarde faite par le serveur)")
    return _sauvegarder(page_id, nom)


def _sauvegarder(page_id, nom):
    dossier = DOSSIER / "_sauvegardes"
    dossier.mkdir(exist_ok=True)
    p = api(f"wp/v2/pages/{page_id}?context=edit")
    chemin = dossier / f"{datetime.now():%Y-%m-%d-%H%M%S}-{nom}-id{page_id}.json"
    chemin.write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")
    return chemin


def ecrire_page(page_id, donnees, nom):
    if page_id:
        print(f"  sauvegarde avant modification : {sauvegarder(page_id, nom).name}")
        return api(f"wp/v2/pages/{page_id}", donnees, "POST")
    return api("wp/v2/pages", donnees, "POST")


def meta_seo(page_id, titre, description, mot_cle, titre_ariane=None):
    meta = {"rank_math_title": titre, "rank_math_description": description,
            "rank_math_focus_keyword": mot_cle, "rank_math_rich_snippet": "off"}
    if titre_ariane:  # nom court affiché dans le fil d'Ariane de Rank Math
        meta["rank_math_breadcrumb_title"] = titre_ariane
    api("rankmath/v1/updateMeta", {"objectType": "post", "objectID": page_id, "meta": meta}, "POST")


def bibliotheque(etat, statut):
    """Crée ou met à jour la page parente /modele-contrat/."""
    b = etat.setdefault("bibliotheque", {})
    en_ligne = statut == "publish" or b.get("statut") == "publish"
    donnees = {"title": BIBLIO_TITRE, "slug": BIBLIO_SLUG, "parent": PARENT_ID,
               "content": page_bibliotheque(etat, publics_seulement=en_ligne),
               "status": "publish" if en_ligne else "draft"}
    p = ecrire_page(b.get("id"), donnees, BIBLIO_SLUG)
    b.update(id=p["id"], statut=p["status"])
    meta_seo(p["id"], "Modèles juridiques gratuits (Word, PDF) | Lumen Juris",
             "Bibliothèque de modèles de contrat gratuits relus par une juriste : pacte d'associés, statuts, CGV... "
             "À télécharger en Word ou PDF, ou à personnaliser en ligne.", "modèle de contrat")
    return p


def publier(slug, en_ligne=False, sans_relecture=False):
    f = fiche(slug)
    # --sans-relecture : utilisé par la routine quotidienne (choix de Geoff, 25 sept 2026).
    # Les micro-données n'annoncent alors aucune relecture (reviewedBy absent).
    if en_ligne and not f["relecture"]["valide"] and not sans_relecture:
        sys.exit("Refus : la relecture juridique n'est pas validée dans fiche.json "
                 "(relecture.valide = true et date_validation).")
    if DIFFERE:
        synchroniser()
    etat = lire_etat()
    em = etat["modeles"].setdefault(slug, {})
    sortie = construire(slug)
    ordre_ouvrir("publier-en-ligne" if en_ligne else "publier", slug)

    # Fichiers à télécharger : renvoyés seulement s'ils ont changé.
    fich = em.setdefault("fichiers", {})
    for k in ("docx", "pdf"):
        chemin = sortie / f"{f['fichier_base']}.{k}"
        # Empreinte du texte source : Word et PDF changent à chaque construction
        # (date interne) même quand le contrat est identique.
        empreinte = hashlib.sha256((DOSSIER / slug / "modele.txt").read_bytes()
                                   + f["url"].encode()).hexdigest()
        if fich.get(k, {}).get("empreinte") != empreinte:
            fich[k] = envoyer_media(chemin)
            fich[k]["empreinte"] = empreinte
            print(f"  fichier envoyé : {fich[k]['url']}")
    image = sortie / f"{f['fichier_base']}.png"
    empreinte = hashlib.sha256(f"{f['nom']}|image-v1".encode()).hexdigest()
    if em.get("image", {}).get("empreinte") != empreinte:
        em["image"] = envoyer_media(image)
        em["image"]["empreinte"] = empreinte
        api(f"wp/v2/media/{em['image']['id']}", {"alt_text": f"Modèle de {f['nom_court']} gratuit – Lumen Juris"}, "POST")
        print(f"  image envoyée : {em['image']['url']}")
    ecrire_etat(etat)

    statut = "publish" if en_ligne else em.get("statut", "draft")
    biblio = bibliotheque(etat, statut)
    em["statut"] = statut
    donnees = {"title": f["titre_h1"], "slug": slug, "parent": biblio["id"], "status": statut,
               "featured_media": em["image"]["id"],
               "content": page_modele(slug, etat, publics_seulement=statut == "publish")}
    p = ecrire_page(em.get("id"), donnees, slug)
    em.update(id=p["id"], statut=p["status"], lien=p["link"])
    meta_seo(p["id"], f["titre_seo"], f["meta_description"], f["mot_cle"], f["nom"])
    ecrire_etat(etat)
    if en_ligne:
        bibliotheque(etat, "publish")
        rafraichir_associes(etat, sauf=slug)
    if _ordre is not None:
        api("elementor/v1/cache", None, "DELETE")
        ordre_fermer(etat)
        print(f"OK {slug} : publication confiée au serveur ({statut})")
        print(f"  adresse prévue : {f['url']}" + ("" if en_ligne else " (brouillon : lien d'aperçu connu après le passage du serveur)"))
        print("  vérifications (HTTP 200, micro-données, plan du site) : au prochain « synchroniser »")
        return
    try:
        import wp_cache
        wp_cache.purge()
    except Exception as err:  # la purge n'est utile qu'aux pages Elementor
        print(f"  (purge Elementor ignorée : {err})")
    print(f"OK {slug} : page {p['id']} ({p['status']})")
    print(f"  aperçu (connecté à WordPress) : {SITE}/?page_id={p['id']}&preview=true")
    if en_ligne:
        verifier(f["url"])


def rafraichir_associes(etat, sauf):
    for s, em in etat["modeles"].items():
        if s != sauf and em.get("statut") == "publish" and em.get("id"):
            api(f"wp/v2/pages/{em['id']}", {"content": page_modele(s, etat)}, "POST")
            print(f"  modèles associés mis à jour : {s}")


def retirer(slug):
    if DIFFERE:
        synchroniser()
    etat = lire_etat()
    em = etat["modeles"][slug]
    ordre_ouvrir("retirer", slug)
    print(f"  sauvegarde : {sauvegarder(em['id'], slug).name}")
    api(f"wp/v2/pages/{em['id']}", {"status": "draft"}, "POST")
    em["statut"] = "draft"
    ecrire_etat(etat)
    bibliotheque(etat, etat.get("bibliotheque", {}).get("statut", "draft"))
    rafraichir_associes(etat, sauf=slug)
    if _ordre is not None:
        ordre_fermer(etat)
        print(f"{slug} : retrait confié au serveur (la page repassera en brouillon à son prochain passage).")
        return
    print(f"{slug} retiré du site (repassé en brouillon).")


def remplacer_reperes(valeur, valeurs):
    if isinstance(valeur, dict):
        return {k: remplacer_reperes(v, valeurs) for k, v in valeur.items()}
    if isinstance(valeur, list):
        return [remplacer_reperes(v, valeurs) for v in valeur]
    if isinstance(valeur, str):
        if valeur in valeurs:  # repère seul : garde le type (numéro de page = nombre)
            return valeurs[valeur]
        return REPERE.sub(lambda m: str(valeurs.get(m.group(0), m.group(0))), valeur)
    return valeur


def synchroniser():
    """Relit le compte rendu du serveur et remplace les repères dans etat.json."""
    etat = lire_etat()
    attente = etat.get("ordres_en_attente", [])
    if not attente:
        return
    try:
        res = json.loads(wp_api.req(f"{RESULTATS_URL}?t={datetime.now():%H%M%S}", auth=False))
    except Exception as err:
        print(f"  compte rendu du serveur illisible ({err}) : {len(attente)} ordre(s) en attente")
        return
    valeurs = {"{{%s.%s.%s}}" % (oid, ref, champ): v
               for oid, r in res.get("ordres", {}).items() if r.get("statut") == "fait"
               for ref, champs in r.get("operations", {}).items() if isinstance(champs, dict)
               for champ, v in champs.items()}
    etat = remplacer_reperes(etat, valeurs)
    faits = []
    for oid in attente:
        r = res.get("ordres", {}).get(oid, {})
        if r.get("statut") == "fait":
            faits.append(oid)
            (ORDRES / f"{oid}.json").unlink(missing_ok=True)
            print(f"  serveur : ordre {oid} exécuté le {r.get('date', '?')}")
        elif r.get("statut") == "erreur":
            print(f"  serveur : ordre {oid} en ERREUR : {r.get('message', '?')}")
        else:
            print(f"  serveur : ordre {oid} pas encore exécuté")
    etat["ordres_en_attente"] = [o for o in attente if o not in faits]
    ecrire_etat(etat)
    for oid in faits:
        slug = re.sub(r"^\d{8}-\d{6}-(publier-en-ligne|publier|retirer)-", "", oid)  # id = date-heure-action-slug
        em = etat["modeles"].get(slug, {})
        if em.get("id"):
            print(f"  {slug} : page {em['id']} ({em.get('statut')}) – aperçu : {SITE}/?page_id={em['id']}&preview=true")
            if em.get("statut") == "publish":
                try:
                    verifier(fiche(slug)["url"])
                except Exception as err:
                    print(f"  ! vérification en ligne impossible : {err}")


def verifier(url):
    page = wp_api.req(url, auth=False)
    plan = wp_api.req(f"{SITE}/page-sitemap.xml?nocache={datetime.now():%H%M%S}", auth=False)
    print(f"  plan du site (lu par Google) : {'page présente' if url in plan else 'page ABSENTE'}")
    blocs = re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', page, flags=re.S)
    for b in blocs:
        json.loads(b)
    print(f"  vérification en ligne : HTTP 200, {len(blocs)} bloc(s) de micro-données valides")


def liste():
    if DIFFERE:
        synchroniser()
    etat = lire_etat()
    for s in tous_les_slugs():
        em = etat["modeles"].get(s, {})
        rel = "relu" if fiche(s)["relecture"]["valide"] else "relecture en attente"
        lien = em.get("lien", "")
        if REPERE.search(json.dumps(em)):
            lien = "(en attente du serveur)"
        print(f"{s:<35} {em.get('statut', 'jamais publié'):<14} {rel:<22} {lien}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "construire":
        construire(args[0])
        apercu(args[0], lire_etat())
    elif cmd == "publier":
        publier(args[0], en_ligne="--en-ligne" in args, sans_relecture="--sans-relecture" in args)
        apercu(args[0], lire_etat())
    elif cmd == "retirer":
        retirer(args[0])
    elif cmd == "liste":
        liste()
    elif cmd == "synchroniser":
        synchroniser()
    else:
        sys.exit(__doc__)
