"""
Tests rapides de services/mise_en_forme.py (sans Google Vision ni fichier).

    back/venv/Scripts/python.exe back/tests/mise_en_forme/test_mise_en_forme.py

(Compatible pytest.) Le banc d'essai complet, sur de vrais documents, est comparer.py.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[3]))

from back.services.mise_en_forme import (  # noqa: E402
    Bloc, MESSAGE_DOC, espaces_ocr, fusionner_coupures, joindre, lire_word, normaliser, parasites,
    texte_depuis_html, vocabulaire,
)


def _joindre(*lignes, texte_du_document=""):
    mots = vocabulaire(texte_du_document + " " + " ".join(lignes))
    return joindre([(l, l) for l in lignes], mots)[0]


def test_texte_propre_jamais_modifie():
    for propre in ["Le prix est de 12.500,00 € HT, soit 3,5 %.", "art. L.1242-8 du Code du travail",
                   "contact@lumenjuris.com ou www.lumenjuris.com", "le 01.02.2026 à 14:30",
                   "LumenJuris SaaS, S.A.S., représentée par M. Dupont"]:
        assert espaces_ocr(normaliser(propre)) == propre


def test_espaces_oubliees_par_un_scan():
    assert espaces_ocr("à l'échéance.Le contrat") == "à l'échéance. Le contrat"
    assert espaces_ocr("les parties,qui conviennent") == "les parties, qui conviennent"
    assert espaces_ocr("ci-après dénommée << le Client >>") == "ci-après dénommée « le Client »"


def test_caracteres_speciaux_des_pdf():
    assert normaliser("10.000 € vice‐président ﬁn") == "10.000 € vice-président fin"


def test_mots_coupes_en_fin_de_ligne():
    assert _joindre("la société est immatricu-", "lée au RCS") == "la société est immatriculée au RCS"
    assert _joindre("représentée par son vice-", "président") == "représentée par son vice-président"
    assert _joindre("c'est-à-", "dire l'accompagnement") == "c'est-à-dire l'accompagnement"
    assert _joindre("tiret conditionnel résilia­", "tion") == "tiret conditionnel résiliation"
    # Le document contient « porte-parole » : le tiret est gardé.
    assert _joindre("son porte-", "parole", texte_du_document="le porte-parole") == "son porte-parole"
    # Pas une coupure de mot : la ligne suivante commence par une majuscule.
    assert _joindre("Article 4 -", "Durée") == "Article 4 - Durée"


def test_l_lu_comme_i_par_un_scan():
    assert _joindre("toute difficu-", "Ité", texte_du_document="la difficulté") == "toute difficulté"
    assert _joindre("le mot inconnu fi-", "Ixe") != "le mot inconnu filxe"


def test_entetes_pieds_et_numeros_de_page():
    elements = []
    for page in range(3):
        elements += [(page, 0.04, 0.05, "LumenJuris – Contrat"), (page, 0.3, 0.4, f"Texte {page}"),
                     (page, 0.96, 0.97, f"Page {page + 1}/3")]
    elements.append((0, 0.06, 0.08, "CONTRAT DE PRESTATION"))  # titre en haut de page 1 : gardé
    retires = parasites(elements, nb_pages=3)
    assert {elements[i][3] for i in retires} == {"LumenJuris – Contrat", "Page 1/3", "Page 2/3", "Page 3/3"}


def test_paragraphe_coupe_par_un_changement_de_page():
    blocs = [Bloc("p", "la somme forfaitaire de 12.500,00", "la somme forfaitaire de 12.500,00"),
             Bloc("p", "€ HT, payable en trois fois.", "€ HT, payable en trois fois."),
             Bloc("p", "Article 4 suivant.", "Article 4 suivant.")]
    resultat = fusionner_coupures(blocs, set())
    assert [b.texte for b in resultat] == ["la somme forfaitaire de 12.500,00 € HT, payable en trois fois.", "Article 4 suivant."]


def test_texte_depuis_html():
    html = "<h1>Titre</h1><p>Un <strong>mot</strong>.</p><table><tr><td>A</td><td>1 €</td></tr></table>"
    assert texte_depuis_html(html) == "Titre\n\nUn mot.\n\nA | 1 €"


def test_ancien_format_word_refuse_avec_un_message_clair():
    try:
        lire_word(b"\xd0\xcf\x11\xe0" + bytes(64))
    except ValueError as erreur:
        assert str(erreur) == MESSAGE_DOC
    else:
        raise AssertionError("Un .doc doit être refusé")


if __name__ == "__main__":
    tests = [f for nom, f in sorted(globals().items()) if nom.startswith("test_")]
    for test in tests:
        test()
        print(f"OK  {test.__name__}")
    print(f"{len(tests)} tests réussis")
