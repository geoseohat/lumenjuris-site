"""
Banc d'essai de la mise en forme : passe chaque document de test dans le VRAI
traitement du moteur (/extract-document-text), puis reproduit ce qu'en font :
  - l'écran « Analyse des risques » (HTML si présent, sinon découpe du texte) ;
  - le texte envoyé à l'IA d'analyse ;
  - l'import de modèle (découpe en paragraphes de proxy/src/routes/template.ts).

    back/venv/Scripts/python.exe back/tests/mise_en_forme/comparer.py avant
    back/venv/Scripts/python.exe back/tests/mise_en_forme/comparer.py apres
    back/venv/Scripts/python.exe back/tests/mise_en_forme/comparer.py rapport

« rapport » assemble les deux passages dans resultats/rapport.html.
Les scans appellent Google Vision (clé du projet) : quelques centimes au plus.
"""
import asyncio
import html as html_module
import io
import json
import re
import sys
from pathlib import Path

ICI = Path(__file__).parent
RACINE = ICI.parents[2]  # dossier lumenjuris
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(ICI))

from generer_documents import EN_TETE, articles  # noqa: E402

DOCUMENTS = ICI / "documents"
RESULTATS = ICI / "resultats"

SENSIBLES = [
    "12.500,00 €", "3,5 %", "L.441-10", "L.1242-8", "www.lumenjuris.com", "dpo@lumenjuris.com",
    "01.02.2026", "14:30", "LumenJuris SaaS", "M. Jean Dupont", "S.A.S.", "vice-président", "c'est-à-dire",
]


# ─── Reproduction du front et du relais ────────────────────────────────────────

def texte_du_html(fragment: str, separateur: str) -> str:
    """Texte d'un HTML : separateur="" reproduit innerText sur un document DOMParser (paragraphes collés)."""
    blocs = re.sub(r"</(p|h[1-6]|li|tr|td|th|table|ul|ol|div)>", lambda m: "</" + m.group(1) + ">" + "\x00", fragment)
    texte = html_module.unescape(re.sub(r"<[^>]+>", "", blocs))
    morceaux = [m.strip() for m in texte.split("\x00")]
    return separateur.join(m for m in morceaux if m) if separateur else "".join(morceaux)


def ecran_sans_html(texte: str) -> str:
    """Copie de formatContentToHtml.ts (processTextFragment) : découpe du texte quand il n'y a pas de HTML."""
    morceaux = re.split(r"(?=(?:Article|Objet))|(?=\*\*)|(?=[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜ][.)\-;])", texte)
    return "".join(
        f"<p>{html_module.escape(m.strip()).replace(chr(10) * 2, '<br/>')}</p>" for m in morceaux if m and m.strip()
    )


def ecran_tiptap(fragment: str) -> str:
    """L'éditeur de l'écran d'analyse (TipTap, StarterKit seul) ne connaît pas les tableaux : chaque case devient un paragraphe."""
    fragment = re.sub(r"<td[^>]*>|<th[^>]*>", "<p>", fragment)
    fragment = re.sub(r"</td>|</th>", "</p>", fragment)
    return re.sub(r"</?(table|tbody|thead|tr)[^>]*>", "", fragment)


def import_paragraphes(texte: str, etiquette: str) -> list:
    """Copie de splitIntoParagraphs (proxy/src/routes/template.ts), avant et après sa correction."""
    if etiquette != "avant" and re.search(r"\n[ \t]*\n", texte):
        return [p for p in (re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n[ \t]*\n", texte)) if p]
    lignes =[re.sub(r"\s+", " ", l).strip() for l in re.split(r"\r?\n", texte)]
    paragraphes = []
    for ligne in (l for l in lignes if l):
        precedent = paragraphes[-1] if paragraphes else None
        if precedent is not None and (re.search(r"[,(–-]$", precedent) or re.match(r"^[a-zàâäçéèêëîïôöûùüÿœ]", ligne)):
            paragraphes[-1] = precedent + " " + ligne
        else:
            paragraphes.append(ligne)
    return paragraphes


# ─── Contrôles automatiques ────────────────────────────────────────────────────

def controles(nom: str, affiche: str, texte_ia: str, paragraphes_import: list) -> dict:
    attendus = len(articles(longue="long" in nom))
    import_texte = "\n".join(paragraphes_import)

    def compte_reperes(t):
        return len(set(re.findall(r"Repère de contrôle n° ?(\d+)", t)))

    def intacts(t):
        return [s for s in SENSIBLES if s in t]

    parasites = lambda t: len(re.findall(r"Page \d+ ?/ ?\d+|" + re.escape(EN_TETE) + r"|\bScan \d+\b", t))
    coupes = lambda t: len(re.findall(r"[a-zàâçéèêëîïôûù]- [a-zàâçéèêëîïôûù]", t))
    return {
        "pages": f"{compte_reperes(affiche)}/{attendus}",
        "pages_ok": compte_reperes(affiche) == attendus,
        "sensibles_ecran": len(intacts(affiche)),
        "sensibles_import": len(intacts(import_texte)),
        "sensibles_total": len(SENSIBLES),
        "abimes_ecran": [s for s in SENSIBLES if s not in affiche],
        "parasites": parasites(affiche),
        "mots_coupes": coupes(affiche) + coupes(import_texte),
        "colles_ia": len(re.findall(r"[a-zé.;:)»][A-ZÉ][a-zé]", texte_ia)),
        "paragraphes_import": len(paragraphes_import),
    }


# ─── Passage d'un document dans le moteur ──────────────────────────────────────

async def extraire(chemin: Path) -> dict:
    from fastapi import UploadFile
    from back.app.main import extract_pdf_text

    fichier = UploadFile(file=io.BytesIO(chemin.read_bytes()), filename=chemin.name)
    try:
        return await extract_pdf_text(file=fichier, scan=False)
    except Exception as erreur:  # le moteur refuse le fichier : on le note tel quel
        return {"erreur": f"{type(erreur).__name__} : {getattr(erreur, 'detail', erreur)}"}


def passer(etiquette: str):
    sortie = RESULTATS / etiquette
    sortie.mkdir(parents=True, exist_ok=True)
    for chemin in sorted(DOCUMENTS.iterdir()):
        resultat = asyncio.run(extraire(chemin))
        texte, fragment = resultat.get("text") or "", resultat.get("html")
        if fragment:
            affiche_html = ecran_tiptap(fragment)
            texte_ia = texte_du_html(fragment, separateur="" if etiquette == "avant" else "\n\n")
        else:
            affiche_html = ecran_sans_html(texte)
            texte_ia = texte
        affiche = texte_du_html(affiche_html, separateur="\n\n")
        paragraphes = import_paragraphes(texte, etiquette)
        donnees = {
            "document": chemin.name,
            "erreur": resultat.get("erreur"),
            "a_du_html": bool(fragment),
            "ecran_html": affiche_html,
            "texte_ia": texte_ia,
            "import": paragraphes,
            "controles": controles(chemin.name, affiche, texte_ia, paragraphes),
        }
        (sortie / f"{chemin.stem}.json").write_text(json.dumps(donnees, ensure_ascii=False, indent=1), encoding="utf-8")
        c = donnees["controles"]
        print(f"{chemin.name:30} pages {c['pages']:>6}  sensibles écran {c['sensibles_ecran']}/{c['sensibles_total']}"
              f"  import {c['sensibles_import']}/{c['sensibles_total']}  parasites {c['parasites']:>2}"
              f"  coupés {c['mots_coupes']:>2}  collés IA {c['colles_ia']:>3}  ¶ import {c['paragraphes_import']:>3}"
              + (f"  ERREUR {donnees['erreur']}" if donnees["erreur"] else ""))


# ─── Rapport avant / après ─────────────────────────────────────────────────────

STYLE = """
:root{--fond:#f5f6f8;--carte:#fff;--texte:#1f2937;--doux:#6b7280;--bord:#e5e7eb;--ok:#047857;--ko:#b91c1c}
@media (prefers-color-scheme:dark){:root{--fond:#111418;--carte:#1b1f24;--texte:#e5e7eb;--doux:#9ca3af;--bord:#2d333b;--ok:#34d399;--ko:#f87171}}
body{margin:0;background:var(--fond);color:var(--texte);font:15px/1.5 system-ui,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:0 0 4px} h2{font-size:18px;margin:32px 0 8px} .doux{color:var(--doux)}
.grille{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:800px){.grille{grid-template-columns:1fr}}
.carte{background:var(--carte);border:1px solid var(--bord);border-radius:10px;padding:14px;min-width:0}
.carte h3{margin:0 0 8px;font-size:15px}
.doc{max-height:420px;overflow:auto;border-top:1px solid var(--bord);margin-top:10px;padding-top:6px;font-family:Georgia,serif;font-size:14px}
.doc p{margin:0 0 .7em} .doc h1,.doc h2,.doc h3{font-size:15px;margin:.8em 0 .4em}
details{margin-top:8px} summary{cursor:pointer;color:var(--doux)}
ol.import{max-height:240px;overflow:auto;font-size:13px;padding-left:28px}
table.ctl{border-collapse:collapse;font-size:13px;width:100%} .ctl td{padding:3px 6px;border-bottom:1px solid var(--bord)}
.ok{color:var(--ok);font-weight:600} .ko{color:var(--ko);font-weight:600}
pre{white-space:pre-wrap;font-size:12px;max-height:160px;overflow:auto}
"""


def _ligne(libelle, valeur, bon):
    return f"<tr><td>{libelle}</td><td class='{'ok' if bon else 'ko'}'>{valeur}</td></tr>"


def _carte(titre, d):
    if d is None:
        return f"<div class='carte'><h3>{titre}</h3><p class='doux'>Pas encore passé.</p></div>"
    c = d["controles"]
    abimes = ", ".join(html_module.escape(s) for s in c["abimes_ecran"]) or "aucun"
    lignes = "".join([
        _ligne("Repères lus (pages)", c["pages"], c["pages_ok"]),
        _ligne("Éléments sensibles intacts à l'écran", f"{c['sensibles_ecran']}/{c['sensibles_total']}", c["sensibles_ecran"] == c["sensibles_total"]),
        _ligne("Éléments sensibles intacts dans le modèle importé", f"{c['sensibles_import']}/{c['sensibles_total']}", c["sensibles_import"] == c["sensibles_total"]),
        _ligne("En-têtes / pieds de page parasites", c["parasites"], c["parasites"] == 0),
        _ligne("Mots coupés en deux", c["mots_coupes"], c["mots_coupes"] == 0),
        _ligne("Paragraphes collés dans le texte envoyé à l'IA", c["colles_ia"], c["colles_ia"] <= 2),
        f"<tr><td>Paragraphes du modèle importé</td><td>{c['paragraphes_import']}</td></tr>",
    ])
    erreur = f"<p class='ko'>{html_module.escape(d['erreur'])}</p>" if d.get("erreur") else ""
    source = "HTML du moteur" if d["a_du_html"] else "texte découpé par le navigateur"
    import_liste = "".join(f"<li>{html_module.escape(p)}</li>" for p in d["import"][:40])
    return (
        f"<div class='carte'><h3>{titre}</h3>{erreur}<table class='ctl'>{lignes}</table>"
        f"<p class='doux'>Éléments abîmés à l'écran : {abimes}</p>"
        f"<p class='doux'>Écran d'analyse ({source}) :</p><div class='doc'>{d['ecran_html']}</div>"
        f"<details><summary>Modèle importé : {len(d['import'])} paragraphes (40 premiers)</summary><ol class='import'>{import_liste}</ol></details>"
        f"<details><summary>Début du texte envoyé à l'IA</summary><pre>{html_module.escape(d['texte_ia'][:1500])}</pre></details></div>"
    )


def rapport():
    def lire(etiquette, stem):
        f = RESULTATS / etiquette / f"{stem}.json"
        return json.loads(f.read_text(encoding="utf-8")) if f.exists() else None

    sections = []
    for chemin in sorted(DOCUMENTS.iterdir()):
        sections.append(
            f"<h2>{html_module.escape(chemin.name)}</h2><div class='grille'>"
            f"{_carte('Avant', lire('avant', chemin.stem))}{_carte('Après', lire('apres', chemin.stem))}</div>"
        )
    page = (
        "<!doctype html><html lang='fr'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>Mise en forme : avant / après</title><style>{STYLE}</style></head><body><main>"
        "<h1>Mise en forme des documents : avant / après</h1>"
        "<p class='doux'>Chaque document passe dans le vrai traitement du moteur Python. L'écran, le texte envoyé à l'IA et "
        "l'import de modèle sont reproduits à l'identique du site.</p>"
        + "".join(sections) + "</main></body></html>"
    )
    (RESULTATS / "rapport.html").write_text(page, encoding="utf-8")
    print(RESULTATS / "rapport.html")


if __name__ == "__main__":
    etape = sys.argv[1] if len(sys.argv) > 1 else "avant"
    rapport() if etape == "rapport" else passer(etape)
