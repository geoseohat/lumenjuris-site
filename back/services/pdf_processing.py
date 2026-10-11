#!/usr/bin/env python3
"""
Utilitaires pour extraction PDF avec Google Cloud Vision
"""
import html as html_module
import logging
import os
import re
import time
import json
import traceback
import difflib
import io
from datetime import datetime
from typing import List, Dict, Any, Optional, Set, TYPE_CHECKING
from urllib.parse import urlparse
from dotenv import load_dotenv

# --- GESTION PROPRE DES IMPORTS OPTIONNELS ---
try:
    import requests
except ImportError:
    requests = None

# SUPPRESSION DE MISTRAL
# from mistralai import Mistral

try:
    from google.cloud import vision
    from google.api_core.client_options import ClientOptions
except ImportError:
    vision = None

try:
    import openai
except ImportError:
    openai = None

# Tentative d'import de PyMuPDF avec gestion d'erreur silencieuse
try:
    import fitz  # PyMuPDF
    PYMUPDF_AVAILABLE = True

except ImportError:
    PYMUPDF_AVAILABLE = False
    print("⚠️ PyMuPDF non installé - utilisation de pdfplumber uniquement")

try:
    import pdfplumber
except ImportError:
    pdfplumber = None

try:
    import mammoth
    MAMMOTH_AVAILABLE = True
except ImportError:
    mammoth = None
    MAMMOTH_AVAILABLE = False
    print("⚠️ mammoth non installé - extraction Word indisponible")

try:
    from docx import Document as DocxDocument
    DOCX_AVAILABLE = True
except ImportError:
    DocxDocument = None
    DOCX_AVAILABLE = False

# --- CORRECTION POUR L'ANALYSEUR DE CODE (PYLANCE) ---
if TYPE_CHECKING:
    # Ceci permet à Pylance de connaître le type sans causer d'erreur à l'exécution
    from PyMuPDF import fitz as fitz_type

# --- SUPPRESSION DES ANCIENS BLOCS D'IMPORT ---

# ---------------------------------------------------------
# Configuration du logging
# ---------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)
logger.info("🟢 Démarrage serveur OCR (Google Vision)")

# ---------------------------------------------------------
# Chargement des clés API
# ---------------------------------------------------------
load_dotenv()

# ---------------------------------------------------------
# Chargement clé API (OBLIGATOIRE)
# ---------------------------------------------------------
# SUPPRESSION DE MISTRAL_API_KEY
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
_openai_client = None
vision_client = None

# Credentials for official jurisprudence APIs (provided via .env)
JUDI_CLIENT_ID = os.environ.get("JUDI_CLIENT_ID")
JUDI_CLIENT_SECRET = os.environ.get("JUDI_CLIENT_SECRET")
LEGI_CLIENT_ID = os.environ.get("LEGI_CLIENT_ID")
LEGI_CLIENT_SECRET = os.environ.get("LEGI_CLIENT_SECRET")
LEGI_ENDPOINT = os.environ.get("LEGI_ENDPOINT")  # optionnel: override pour lf-engine-app
LEGI_SCOPE = os.environ.get("LEGI_SCOPE")  # optionnel: scope requis par votre produit PISTE Légifrance
LEGI_AUDIENCE = os.environ.get("LEGI_AUDIENCE")  # optionnel: audience si nécessaire
JUDI_SCOPE = os.environ.get("JUDI_SCOPE")  # optionnel
JUDI_AUDIENCE = os.environ.get("JUDI_AUDIENCE")  # optionnel
JUDI_ENDPOINT = os.environ.get("JUDI_ENDPOINT")  # optionnel
JUDI_PROXY = os.environ.get("JUDI_PROXY")  # optionnel, proxy explicite pour Judilibre

# Config proxy générique (requests lit aussi automatiquement HTTP(S)_PROXY)
_HTTP_PROXY = os.environ.get('HTTP_PROXY') or os.environ.get('http_proxy')
_HTTPS_PROXY = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
_PROXIES = None
if JUDI_PROXY:
    _PROXIES = {"http": JUDI_PROXY, "https": JUDI_PROXY}
elif _HTTP_PROXY or _HTTPS_PROXY:
    _PROXIES = {"http": _HTTP_PROXY or _HTTPS_PROXY, "https": _HTTPS_PROXY or _HTTP_PROXY}

# SUPPRESSION DU BLOC DE CONFIGURATION MISTRAL

# --- AJOUT : Configuration propre du client OpenAI ---
if openai and OPENAI_API_KEY:
    try:
        _openai_client = openai.OpenAI(api_key=OPENAI_API_KEY)
        logger.info("✅ Client OpenAI configuré.")
    except Exception as e:
        logger.error(f"❌ Échec configuration OpenAI: {e}")
        _openai_client = None
elif openai:
    logger.warning("⚠️ Clé API OpenAI (OPENAI_API_KEY) non fournie. La détection de clauses par IA est désactivée.")
else:
    logger.warning("⚠️ Module 'openai' non trouvé. La détection de clauses par IA est désactivée.")



# Configuration du client Google Vision
if vision:
    try:
        # Chemin absolu du fichier credentials dans le dossier courant du projet
        credentials_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gen-lang-client-0501326750-4f358317bac6.json")
        if os.path.exists(credentials_path):
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = credentials_path
            client_options = ClientOptions(api_endpoint="eu-vision.googleapis.com")
            vision_client = vision.ImageAnnotatorClient(client_options=client_options)
            logger.info(f"✅ Client Google Cloud Vision configuré avec {credentials_path}.")
        else:
            logger.error(f"❌ Fichier credentials Google Vision introuvable: {credentials_path}")
    except Exception as e:
        logger.error(f"❌ Échec configuration Google Cloud Vision: {e}")
else:
    logger.warning("⚠️ Module 'google-cloud-vision' non trouvé. L'OCR Google Vision est désactivé.")

# ---------------------------------------------------------
# Configuration
# ---------------------------------------------------------
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB max
ALLOWED_EXTENSIONS = {'pdf', 'doc', 'docx'}

def allowed_file(filename):
    """Vérifie si le fichier est autorisé"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# ---------------------------------------------------------
# Outils de correction/cleaning du texte OCR
# ---------------------------------------------------------
def corriger_espaces(text):
    # Ajoute un espace entre une minuscule/accent et une majuscule collée
    text = re.sub(r'([a-zéèàùâêîôûç])([A-ZÉÈÀÙÂÊÎÔÛÇ])', r'\1 \2', text)
    # Ajoute un espace après les signes de ponctuation si absent
    text = re.sub(r'([.,;:!?])([^\s])', r'\1 \2', text)
    # Remplace les doubles espaces par un seul
    text = re.sub(r' {2,}', ' ', text)
    return text

def nettoyer_artefacts_ocr(text):
    """Supprime quelques artefacts LaTeX fréquemment vus en OCR"""
    text = re.sub(r'\$\\qquad\$', '    ', text)
    text = re.sub(r'\$\\square\$', '☐', text)
    text = re.sub(r'\$\\quad\$', '  ', text)
    text = re.sub(r'\$[^$]*\$', '', text)
    text = re.sub(r'\\[a-zA-Z]+\{[^}]*\}', '', text)
    text = re.sub(r'\\[a-zA-Z]+', '', text)
    text = re.sub(r' {3,}', '   ', text)
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def detecter_mots_colles_evidence(texte):
    """Détecte SEULEMENT les cas absolument flagrants"""
    patterns = [
        r'\barticle\d+[A-Z][a-z]{6,}\b',         # "article4Chaque"
        r'\b[a-z]{5,}[A-Z][a-z]{5,}[A-Z][a-z]{5,}\b',  # "chaqueÉpouxDoit"
        r'\b[a-z]{25,}\b',                        # très longs
        r'\b[a-z]+de[a-z]+de[a-z]+\b',            # "absencedecontratsigné"
        r'\b[a-z]+aux[a-z]+le[a-z]+\b',           # "laisseauxépouxle"
        r'\bc\'est[a-z]+de[a-z]+\b'               # "c'estlerégimede"
    ]
    suspects = []
    for pattern in patterns:
        for match in re.finditer(pattern, texte, re.IGNORECASE):
            if len(match.group()) > 15:
                suspects.append((match.group(), match.start(), match.end()))
    return suspects

def valider_correction_critique(mot):
    if re.search(r'^[A-Z][a-z]+[A-Z]', mot):  # CamelCase
        return False
    if re.search(r'\d', mot):                 # contient des chiffres
        return False
    if len(mot) < 15:
        return False
    return True

def corriger_mot_ia_minimal(mot_original):
    """Utilise OpenAI pour DÉSACTIVER la correction si moindre doute (ajout d'espaces uniquement)."""
    # MODIFICATION : On vérifie le client OpenAI
    if not _openai_client:
        return mot_original
    prompt = f"""Tu es un correcteur de texte français ultra-prudent.

RÈGLES STRICTES :
- Corrige SEULEMENT si tu es SÛR à 100% que des mots français sont collés
- Ajoute SEULEMENT des espaces, ne change AUCUNE lettre
- Si tu as le moindre doute, retourne exactement : "{mot_original}"
- Ne corrige PAS les noms propres, marques, codes juridiques

Mot à analyser : "{mot_original}"

Correction :"""
    try:
        # MODIFICATION : Remplacement de l'appel Mistral par OpenAI
        response = _openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            max_tokens=50
        )
        correction = response.choices[0].message.content.strip()
        if not correction or correction == mot_original:
            return mot_original
        if len(correction) > len(mot_original) * 1.5:
            return mot_original
        lettres_orig = re.sub(r'[^a-zA-Zéèàùâêîôûç]', '', mot_original.lower())
        lettres_corr = re.sub(r'[^a-zA-Zéèàùâêîôûç]', '', correction.lower())
        if len(lettres_corr) < len(lettres_orig) * 0.9:
            return mot_original
        return correction
    except Exception as e:
        logger.warning(f"Erreur correction IA (OpenAI) pour '{mot_original}': {e}")
        return mot_original

def corriger_texte_ultra_securise(texte):
    """Correction minimale pour préserver l'analyse des clauses"""
    texte = corriger_espaces(texte)
    mots_suspects = detecter_mots_colles_evidence(texte)
    corrections_effectuees = 0
    for mot_original, start, end in mots_suspects[:8]:
        if corrections_effectuees >= 5:
            break
        if valider_correction_critique(mot_original):
            mot_corrige = corriger_mot_ia_minimal(mot_original)
            if mot_corrige != mot_original:
                texte = texte.replace(mot_original, mot_corrige, 1)
                logger.info(f"✏️ Correction {corrections_effectuees + 1}/5: '{mot_original}' → '{mot_corrige}'")
                corrections_effectuees += 1
    if corrections_effectuees == 0:
        logger.info("📝 Aucune correction IA nécessaire")
    return texte

# La lecture des documents (Word, PDF, scans) est dans services/mise_en_forme.py.

# ---------------------------------------------------------
# (Optionnel) Détection simple de clauses
# ---------------------------------------------------------

# VOTRE ANCIENNE FONCTION EST CONSERVÉE INTACTE COMME PLAN DE SECOURS
def extract_clauses_with_positions(text):
    logger.info(f"🔍 Début détection clauses sur {len(text)} caractères")
    logger.info(f"📝 Extrait du texte: {repr(text[:500])}")
    clause_patterns = [
        {"regex": r"ARTICLE\s+\d+[\s\S]*?(?=ARTICLE\s+\d+|$)", "type": "Article contractuel"},
        {"regex": r"\d+\.\s+[\s\S]*?(?=\d+\.|$)", "type": "Clause numérotée"},
        {"regex": r"\d+\)\s+[\s\S]*?(?=\d+\)|$)", "type": "Clause avec parenthèses"},
        {"regex": r"[A-Z][^.!?]*(responsabilité|liability)[^.!?]*[.!?]", "type": "Limitation de responsabilité"},
        {"regex": r"[A-Z][^.!?]*(résiliation|termination|expiration)[^.!?]*[.!?]", "type": "Clause de résiliation"},
        {"regex": r"[A-Z][^.!?]*(confidentialité|confidential|secret)[^.!?]*[.!?]", "type": "Clause de confidentialité"},
        {"regex": r"[A-Z][^.!?]*(indemnité|pénalité|penalty|dommages)[^.!?]*[.!?]", "type": "Clause pénale"},
        {"regex": r"[A-Z][^.!?]*(concurrence|competition|exclusivité)[^.!?]*[.!?]", "type": "Clause de non-concurrence"},
        {"regex": r"[A-Z][^.!?]*(garantie|warranty|assurance)[^.!?]*[.!?]", "type": "Clause de garantie"},
        {"regex": r"[A-Z][^.!?]*(loyer|bail|location|locataire|bailleur)[^.!?]*[.!?]", "type": "Clause de bail"},
        {"regex": r"##?\s+([A-ZÉÈÀÙÂÊÎÔÛÇ][^\n]*)", "type": "Titre de section"},
        {"regex": r"\*\*([^*]+)\*\*", "type": "Texte en gras"},
        {"regex": r"^\s*-\s+([A-ZÉÈÀÙÂÊÎÔÛÇ][^\n]*)", "type": "Point avec tiret"},
    ]
    clauses = []
    for pat in clause_patterns:
        pattern = re.compile(pat["regex"], re.IGNORECASE | re.DOTALL | re.MULTILINE)
        for match in pattern.finditer(text):
            clause_text = match.group().strip()
            if 20 < len(clause_text) < 3000:
                clauses.append({
                    "text": clause_text,
                    "startPosition": match.start(),
                    "endPosition": match.end(),
                    "type": pat["type"]
                })
    for m in re.finditer(r"([A-ZÉÈÀÙÂÊÎÔÛÇ][A-ZÉÈÀÙÂÊÎÔÛÇ\s]{4,}):", text):
        start = m.start()
        end = text.find('\n', start)
        if end == -1:
            end = min(start + 400, len(text))
        clause_text = text[start:end].strip()
        if 20 < len(clause_text) < 3000:
            clauses.append({
                "text": clause_text,
                "startPosition": start,
                "endPosition": end,
                "type": "Titre en majuscules"
            })
    uniq, seen = [], set()
    for c in sorted(clauses, key=lambda x: x["startPosition"]):
        key = c["startPosition"] // 20
        if key not in seen:
            uniq.append(c)
            seen.add(key)
    logger.info(f"📍 {len(uniq)} clauses détectées côté serveur (méthode Regex)")
    return uniq[:20]





# --- NOUVELLE FONCTION ROBUSTE (IA + difflib) ---
def extract_clauses_ia_robuste(text: str) -> List[Dict[str, Any]]:
    """
    Détecte les clauses en utilisant OpenAI pour la sémantique et difflib pour une localisation parfaite.
    Utilise extract_clauses_with_positions (Regex) comme fallback.
    """
    if not _openai_client:
        logger.warning("Client OpenAI non disponible, utilisation du fallback Regex.")
        return extract_clauses_with_positions(text)

    logger.info("🔍 Début détection de clauses par IA (OpenAI + difflib)")

    # --- CORRECTION DÉFINITIVE DU PROMPT ---
    # On demande explicitement un objet JSON avec une clé "clauses".

    logger.info("tentative de separation du nom de l'article depuis le prompt")
    prompt = """Tu es un assistant juridique expert. Analyse le contrat suivant.
Ta réponse DOIT être un unique objet JSON. Cet objet doit contenir une seule clé: "clauses".
La valeur de "clauses" doit être un tableau d'objets.
Chaque objet du tableau représente une clause et doit avoir deux clés :
1. "titre": Un titre court et descriptif pour la clause.
2. "texte_exact": Le texte complet et **absolument inchangé** de la clause.


Voici le texte à analyser :
""" + text
    
    try:
        response = _openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        response_content = response.choices[0].message.content
        
        # --- CORRECTION DÉFINITIVE DU PARSING ---
        # Le code devient beaucoup plus simple et robuste.
        response_data = json.loads(response_content)
        
        # On récupère directement la liste depuis la clé "clauses".
        # .get() est sûr et renvoie une liste vide si la clé n'existe pas.
        clauses_ia = response_data.get("clauses", [])
        
        # CORRECTION 3 (Logique IA) : On ne lève plus d'erreur si la liste est vide.
        # C'est un résultat valide (pas de clauses trouvées).
        if not isinstance(clauses_ia, list):
             raise ValueError("La clé 'clauses' n'est pas une liste dans la réponse de l'IA.")

    except Exception as e:
        logger.error(f"❌ Erreur lors de l'appel ou du parsing OpenAI: {e}")
        logger.warning("Échec de l'IA, utilisation du fallback Regex.")
        return extract_clauses_with_positions(text)

    final_clauses = []
    for clause in clauses_ia:
        if not isinstance(clause, dict) or "texte_exact" not in clause:
            continue
        
        ai_text = clause["texte_exact"]
        
        # --- Étape de recalage avec difflib ---
        matcher = difflib.SequenceMatcher(None, text, ai_text, autojunk=False)
        match = matcher.find_longest_match(0, len(text), 0, len(ai_text))
        
        # On accepte une correspondance si elle couvre au moins 90% du texte de l'IA
        if match.size > len(ai_text) * 0.9:
            start_pos = match.a
            end_pos = match.a + match.size
            
            final_clauses.append({
                "text": text[start_pos:end_pos],
                "startPosition": start_pos,
                "endPosition": end_pos,
                "type": clause.get("titre", "Clause IA")
            })

    # CORRECTION 4 (Logique IA) : On ne bascule plus vers Regex si l'IA renvoie 0 clause.
    # On accepte le résultat de l'IA, même s'il est vide.
    if not final_clauses and clauses_ia:
        # Ce log se déclenche si l'IA a renvoyé du texte mais que difflib n'a rien pu aligner.
        logger.warning("Les clauses de l'IA n'ont pas pu être localisées dans le texte, utilisation du fallback Regex.")
        return extract_clauses_with_positions(text)

    logger.info(f"✅ {len(final_clauses)} clauses détectées par IA et vérifiées par difflib.")
    return final_clauses



# ---------------------------------------------------------
# Jurisprudence vérifiée (Judilibre / Légifrance)
# ---------------------------------------------------------

AUTHORIZED_DOMAINS = (
    'legifrance.gouv.fr',
    'courdecassation.fr',
    'conseil-etat.fr',
)

def _is_authorized_domain(url: str) -> bool:
    try:
        from urllib.parse import urlparse
        h = urlparse(url).hostname or ''
        return any(h == d or h.endswith('.' + d) for d in AUTHORIZED_DOMAINS)
    except Exception:
        return False

def _require_requests():
    if requests is None:
        raise RuntimeError("Le module 'requests' n'est pas installé. Ajoutez-le à requirements.txt et installez-le.")

# Sanitize queries: remove 'clause', drop geolocation, cap to 8 words
_GEO_TOKENS = re.compile(r"\b(france|territoire|région|region|départements?|departements?|communes?|europe|européen|europeen|ue|union\s+europ)\b", re.IGNORECASE)
def _sanitize_query_text(q: str) -> str:
    try:
        s = (q or "").strip()
        if not s:
            return s
        # Remove the word 'clause'
        s = re.sub(r"\bclause\s+de\s+", "", s, flags=re.IGNORECASE)
        s = re.sub(r"\bclause\b", "", s, flags=re.IGNORECASE)
        # Remove geolocation tokens
        s = _GEO_TOKENS.sub("", s)
        # Remove empty quote pairs produced after stripping (e.g., "France entière" -> "")
        s = re.sub(r'"\s*"', "", s)
        # Collapse whitespace
        s = re.sub(r"\s{2,}", " ", s).strip()
        # Cap to 8 words max
        parts = s.split()
        if len(parts) > 8:
            parts = parts[:8]
        return " ".join(parts)
    except Exception:
        return q or ""

# ---------------------------------------------------------
# Génération de mots-clés pour requêtes (heuristique + IA)
# ---------------------------------------------------------
_FR_STOPWORDS = set("""
au aux avec ce cet cette ces ça ceci cela celui celle celles ceux
chaque comme comment dans de des du dès donc dont elle elles en encore
entre et exactement être été fait fais fait fait-on font hors ici il ils
je la le les leur leurs lui là lorsque lors mais même même si mes mon ma
ne nos notre nous on ou où par parce pendant plus pour pourquoi quand que
quel quelles quel quel(s) quelle(s) qui quoique s sa se ses si sinon son
sous sur ta te tes toi ton tu un une unes uns vers via vos votre vous
afin alors ainsi aussi autant autre autres avant après autour cependant
tandis tandis que toutefois toujours très très bien très peu très mal
""".split())

# Bruit typique à ignorer (extensible)
_NOISE = set("""
article articles chapitre section annexe page figure tableau exemple
contrat contrat(s) prestataire client partie parties service services
""".split())

def _normalize_text(s: str) -> str:
    s = re.sub(r"[\n\r\t]+", " ", s or "").lower()
    s = re.sub(r"[^a-z0-9àâçéèêëîïôûùüÿñæœ\s-]", " ", s)
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s

def _extract_keywords_basic(text: str, max_terms: int = 10) -> List[str]:
    txt = _normalize_text(text)
    # jeter nombres, dates, identifiants
    words = []
    for w in re.split(r"\s+", txt):
        if not w:
            continue
        if w in _FR_STOPWORDS or w in _NOISE:
            continue
        if re.fullmatch(r"\d+|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}", w):
            continue
        if len(w) < 3:
            continue
        words.append(w)

    # fréquence simple
    freq: Dict[str, int] = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1

    # bonus juridiques
    bonus = {
        "non-concurrence": 4, "liberte": 2, "travail": 2,
        "resiliation": 2, "confidentialite": 2, "responsabilite": 2,
        "penalite": 2, "astreinte": 2, "garantie": 2, "vise": 1, "vices": 1
    }
    scored = []
    for w, c in freq.items():
        scored.append((w, c + bonus.get(w, 0)))

    scored.sort(key=lambda t: t[1], reverse=True)

    # PAS de racine 6 lettres : dédupli simple
    out, seen = [], set()
    for w, _ in scored:
        key = w.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(w)
        if len(out) >= max_terms:
            break
    return out

def _extract_structured_facts(text: str) -> Dict[str, Any]:
    """Extrait des faits structurés utiles pour la recherche (durée, période post‑contractuelle, périmètre, secteur, type de clause)."""
    s = (text or '')
    low = s.lower()
    facts: Dict[str, Any] = {
        'duration_years': None,
        'post_contractual': False,
        'territory': None,
        'sector': None,
        'clause_type': None,
    }
    # Durée en années (valeurs numériques simples)
    m = re.search(r"(\d+)\s*(?:an|ans|année|années)", low)
    if m:
        try:
            facts['duration_years'] = int(m.group(1))
        except Exception:
            pass
    # Période post‑contractuelle
    if ('après la cessation' in low) or ('apres la cessation' in low) or ('après la fin' in low) or ('apres la fin' in low) or ('après sa cessation' in low) or ('apres sa cessation' in low):
        facts['post_contractual'] = True
    # Territoire (France entière)
    if ('ensemble du territoire français' in low) or ('territoire français' in low) or ('territoire francais' in low) or ('france entière' in low) or ('france entiere' in low):
        facts['territory'] = 'France entière'
    # Secteur: "secteur des/du/de la/de l' X"
    sec = None
    for pat in [
        r"secteur\s+des\s+([^,.;\n]+)",
        r"secteur\s+du\s+([^,.;\n]+)",
        r"secteur\s+de\s+la\s+([^,.;\n]+)",
        r"secteur\s+de\s+l'([^,.;\n]+)",
        r"dans\s+le\s+secteur\s+(?:des|du|de\s+la|de\s+l')\s*([^,.;\n]+)",
    ]:
        mm = re.search(pat, low)
        if mm:
            sec = mm.group(1).strip()
            break
    if sec:
        facts['sector'] = sec
    # Type de clause (non‑concurrence) par motifs usuels
    if ('non-concurrence' in low) or ('non concurrence' in low) or ('aucun service similaire' in low) or ('activité similaire' in low) or ('activite similaire' in low) or ('ne fournir aucun service similaire' in low):
        facts['clause_type'] = 'non-concurrence'
    return facts

def _derive_fact_terms(facts: Dict[str, Any]) -> List[str]:
    """
    Génère des termes courts, pertinents et universels à partir des faits structurés.
    - Supprime les mots inutiles comme 'clause', la géolocalisation, etc.
    - Limite à 8 mots max et coupe le dernier si besoin.
    """
    terms: List[str] = []

    # Type de clause générique
    if facts.get('clause_type'):
        # On ne met pas "clause de", juste le type
        terms.append(facts['clause_type'])

    # Post-contractuel
    if facts.get('post_contractual'):
        terms.append('post-contractuel')

    # Durée
    if isinstance(facts.get('duration_years'), int):
        terms.append(f"{facts['duration_years']} ans")

    # Secteur
    if facts.get('sector'):
        terms.append(facts['sector'])

    # Supprimer doublons
    seen = set()
    terms = [t for t in terms if not (t.lower() in seen or seen.add(t.lower()))]

    # Limite stricte à 8 mots, couper si nécessaire
    if len(terms) > 8:
        terms = terms[:8]

    return terms


def _extract_keywords_ai(text: str, max_terms: int = 10, category: Optional[str] = None) -> Optional[List[str]]:
    clause_name_hint = f"Nom de la clause: {category}.\n" if category else ""
    cat_map = {
        'nonCompete': 'non-concurrence, exclusivité, liberté du travail',
        'confidentiality': 'confidentialité, secret des affaires',
        'termination': 'résiliation, préavis, résiliation unilatérale',
        'responsibility': 'limitation de responsabilité, indemnisation, dommages-intérêts',
        'penalty': 'clause pénale, astreinte, pénalité',
        'warranty': 'garantie, vices cachés'
    }
    cat_hint = f"Contexte: {cat_map.get(category, '')}\n" if category else ""

    prompt = (
        "Rôle: juriste. Objectif: extraire des mots-clés compacts pour chercher de la jurisprudence FR.\n"
        "Contraintes STRICTES:\n"
        "- 1 mot-clé par ligne, sans numéro, sans puce\n"
        "- max 10 lignes\n"
        "- pas de mots vides ni de prépositions\n"
        "- privilégier termes juridiques et expressions composées utiles (garder les tirets)\n"
        "- pas de phrases complètes\n\n"
        f"{clause_name_hint}{cat_hint}"
        f"Texte:\n{text[:2000]}\n\n"
        "MOTS-CLÉS (1 par ligne, pas de numérotation):"
    )

    def _clean_lines(s: str) -> List[str]:
        raw = [ln.strip() for ln in s.splitlines() if ln.strip()]
        cleaned, seen = [], set()
        for ln in raw:
            ln = re.sub(r"^[\-\*\d\.\)\s]+", "", ln)  # retire puces/numéros
            ln = re.sub(r"\s{2,}", " ", ln)
            if 2 <= len(ln) <= 60 and ln.lower() not in _FR_STOPWORDS and ln.lower() not in seen:
                cleaned.append(ln)
                seen.add(ln.lower())
        return cleaned[:max_terms]

    # MODIFICATION : On utilise uniquement OpenAI
    if _openai_client:
        try:
            resp = _openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=100
            )
            content = resp.choices[0].message.content or ""
            kws = _clean_lines(content)
            if kws:
                return kws
        except Exception as e:
            logger.warning(f"OpenAI keywords error: {e}")

    return None

def _quote_term(t: str) -> str:
    t = t.strip()
    if " " in t or "-" in t:
        return f'"{t}"'
    return t

def _build_search_terms(clause_text: str, category: Optional[str] = None) -> List[str]:
    # 0) Faits structurés forts extraits par règles
    facts = _extract_structured_facts(clause_text)
    fact_terms = _derive_fact_terms(facts)
    # 1) IA (OpenAI ou Mistral) en priorité pour qualité
    ai_terms = _extract_keywords_ai(clause_text, max_terms=12, category=category) or []
    # 2) Heuristique en complément (dépriorisée et filtrée)
    base_terms = _extract_keywords_basic(clause_text, max_terms=10)
    # 3) Catégorie → mots-clés spécifiques
    # Termes par catégorie (sans le mot « clause »)
    cat_terms: Dict[str, List[str]] = {
        'nonCompete': ['non-concurrence', 'liberté du travail', 'contrepartie financière'],
        'confidentiality': ['confidentialité', 'secret des affaires'],
        'termination': ['résiliation unilatérale', 'préavis'],
        'responsibility': ['limitation de responsabilité', 'dommages-intérêts'],
        'penalty': ['pénalité', 'astreinte'],
        'warranty': ['garantie', 'vices cachés']
    }
    extra = cat_terms.get((category or 'other'), [])

    # Collecte brute filtrée
    raw: List[str] = []
    seen_raw: Set[str] = set()
    # Règles de filtrage: retirer géolocalisation et le mot « clause »
    GEO_PAT = re.compile(r"\b(france|territoire|région|region|département|departement|commune|europe|européen|europeen|ue|union\s+europ)\b", re.IGNORECASE)
    def _strip_clause_word(t: str) -> str:
        t2 = re.sub(r"\bclause\s+de\s+", "", t, flags=re.IGNORECASE)
        t2 = re.sub(r"\bclause\s+", "", t2, flags=re.IGNORECASE)
        return t2.strip()

    for term in fact_terms + ai_terms + extra + base_terms:
        t = term.strip()
        if not t:
            continue
        t = _strip_clause_word(t)
        if not t:
            continue
        # Filtrer géolocalisation
        if GEO_PAT.search(t):
            continue
        low = t.lower()
        if low in {"contrat", "service", "services"}:
            continue
        if low in seen_raw:
            continue
        seen_raw.add(low)
        raw.append(t)

    # Construire des requêtes compactes: un terme exact (quoted) + 1-2 affinants
    queries: List[str] = []
    queries: List[str] = []
    i = 0
    while i < len(raw) and len(queries) < 8:
        head = _quote_term(raw[i])
        tail: List[str] = []
        j = i + 1
        while j < len(raw) and len(tail) < 2:
            tail.append(raw[j])
            j += 1
        q = " ".join([head] + tail)
        queries.append(q)
        i = j

    # Unicité, limite, et coupe si > 8 mots
    seen_q: Set[str] = set()
    out: List[str] = []
    for q in queries:
        ql = q.lower()
        if ql in seen_q:
            continue
        seen_q.add(ql)

        # Vérifier le nombre de mots (max 8)
        mots = q.split()
        if len(mots) > 8:
            mots = mots[:8]
        out.append(" ".join(mots))

        if len(out) >= 6:
            break
    return out


def _get_judilibre_token() -> Optional[str]:
    """Récupère un token via PISTE pour Judilibre si identifiants fournis."""
    if not (JUDI_CLIENT_ID and JUDI_CLIENT_SECRET):
        return None
    try:
        _require_requests()
        # PISTE OAuth2 Client Credentials (audience spécifique Judilibre peut être requise)
        token_url = 'https://oauth.piste.gouv.fr/api/oauth/token'
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        form = {
            'grant_type': 'client_credentials',
            'client_id': JUDI_CLIENT_ID,
            'client_secret': JUDI_CLIENT_SECRET,
        }
        # Inclure scope/audience si fournis (variable selon contrat PISTE)
        if JUDI_SCOPE:
            form['scope'] = JUDI_SCOPE
        if JUDI_AUDIENCE:
            form['audience'] = JUDI_AUDIENCE

        # Petit retry (x2) pour limiter les erreurs transitoires
        last_err = None
        for attempt in range(2):
            try:
                resp = requests.post(token_url, data=form, headers=headers, timeout=6, proxies=_PROXIES)
                if resp.ok:
                    js = resp.json()
                    tok = js.get('access_token')
                    if tok:
                        # ==================================================
                        # ===> ACTION 1 : LOG DE SUCCÈS POUR LE TOKEN <===
                        # ==================================================
                        logger.info(f"✅ [PISTE Token] Token Judilibre obtenu avec succès. Aperçu: {tok[:5]}...{tok[-5:]}")
                        return tok
                else:
                    last_err = f"{resp.status_code} {str(resp.text)[:120]}"
            except Exception as e:
                last_err = str(e)
            # Backoff léger
            time.sleep(0.3)
        if last_err:
            logger.warning(f"Judilibre token error: {last_err}")
    except Exception as e:
        logger.warning(f"Judilibre token error: {e}")
    return None

def _get_legifrance_token() -> Optional[str]:
    """Récupère un token via PISTE pour Légifrance si identifiants fournis."""
    if not (LEGI_CLIENT_ID and LEGI_CLIENT_SECRET):
        return None
    try:
        _require_requests()
        token_url = 'https://oauth.piste.gouv.fr/api/oauth/token'
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        form = {
            'grant_type': 'client_credentials',
            'client_id': LEGI_CLIENT_ID,
            'client_secret': LEGI_CLIENT_SECRET,
        }
        # Certaines souscriptions exigent scope et/ou audience (voir votre espace PISTE)
        if LEGI_SCOPE:
            form['scope'] = LEGI_SCOPE
        if LEGI_AUDIENCE:
            form['audience'] = LEGI_AUDIENCE
        last_err = None
        for attempt in range(2):
            try:
                resp = requests.post(token_url, data=form, headers=headers, timeout=6, proxies=_PROXIES)
                if resp.ok:
                    js = resp.json()
                    tok = js.get('access_token')
                    if tok:
                        return tok
                else:
                    last_err = f"{resp.status_code} {str(resp.text)[:120]}"
            except Exception as e:
                last_err = str(e)
            time.sleep(0.3)
        if last_err:
            logger.warning(f"Legifrance token error: {last_err}")
    except Exception as e:
        logger.warning(f"Legifrance token error: {e}")
    return None

def _legifrance_search(query: str, limit: int = 3) -> List[Dict[str, Any]]:
    """Recherche via Légifrance (lf-engine-app) en utilisant le format de requête validé."""

    # --- Fonction utilitaire locale pour extraire un titre quelle que soit la structure ---
    def _extract_title(it: Dict[str, Any]) -> Optional[str]:
        # 1) Champ 'title' ou 'titre' direct
        ttl = it.get('title') or it.get('titre')
        if ttl:
            return ttl
        # 2) Tableau 'titles' renvoyé par Légifrance
        titles_arr = it.get('titles')
        if isinstance(titles_arr, list):
            for sub in titles_arr:
                if isinstance(sub, dict):
                    ttl2 = sub.get('title') or sub.get('titre')
                    if ttl2:
                        return ttl2
        return None

    try:
        token = _get_legifrance_token()
        if not token:
            logger.info("🚫 [Légifrance Search] Pas de token, recherche annulée.")
            return []
        
        _require_requests()
        url = LEGI_ENDPOINT or 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search'
        headers = {
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
        
        # Structure de requête qui correspond à votre exemple fonctionnel.
        body = {
            "fond": "JURI",
            "recherche": {
                "champs": [
                    {
                        "typeChamp": "TEXTE",
                        "operateur": "ET",
                        "criteres": [
                            {
                                "typeRecherche": "UN_DES_MOTS",
                                "valeur": query.replace('"', ''),
                                "operateur": "ET"
                            }
                        ]
                    }
                ],
                "pageNumber": 1,
                "pageSize": limit,
                "sort": "PERTINENCE",
                "typePagination": "DEFAUT",
                "operateur": "ET"
            }
        }

        logger.info(f"📦 [Légifrance Search] Envoi de la requête avec le corps: {json.dumps(body)}")
        r = requests.post(url, headers=headers, data=json.dumps(body), timeout=8, proxies=_PROXIES)
        
        logger.info(f"🔍 [Légifrance DEBUG] Réponse textuelle BRUTE: {r.text}")

        if not r.ok:
            logger.warning(f"❌ [Légifrance Search] Échec: {r.status_code} {str(r.text)[:200]}")
            return []
        
        logger.info(f"✅ [Légifrance Search] Succès: {r.status_code}")
        data = r.json() or {}
        items = (
            data.get('results')
            or data.get('resultsListe')
            or data.get('items')
            or data.get('resultats')
            or []
        )
        JURI_RE = re.compile(r'JURITEXT\w+', re.IGNORECASE)

        def _find_juri_id(obj) -> Optional[str]:
            try:
                if isinstance(obj, str):
                    m = JURI_RE.search(obj)
                    return m.group(0).upper() if m else None
                if isinstance(obj, dict):
                    for k in ('id', 'cid', 'documentId', 'identifiant', 'numero', 'title', 'titre'):
                        v = obj.get(k)
                        if isinstance(v, str):
                            m = JURI_RE.search(v)
                            if m:
                                return m.group(0).upper()
                    for v in obj.values():
                        rid = _find_juri_id(v)
                        if rid:
                            return rid
                if isinstance(obj, (list, tuple, set)):
                    for el in obj:
                        rid = _find_juri_id(el)
                        if rid:
                            return rid
            except Exception:
                return None
            return None

        out: List[Dict[str, Any]] = []

        def _pick(val, *alts):
            if val:
                return val
            for a in alts:
                if a:
                    return a
            return None

        if not items:
            items = [data]

        for it in items:
            if not isinstance(it, dict):
                continue
            juri_id = _find_juri_id(it)
            numero = _pick(it.get('numeroDecision'), it.get('cid'), it.get('nor'))
            date_str = _pick(it.get('dateDecision'), it.get('datePrononcee'), it.get('datePublication'))
            # ===> AMÉLIORATION 1 : Ne plus utiliser de valeur par défaut générique
            court = _pick(it.get('juridiction'), it.get('juridictionJudiciaire'), it.get('formation'), it.get('chambre'))
            resume = _pick(it.get('titre'), it.get('title'), it.get('resume'))

            # ===> AMÉLIORATION 2 : Le titre est le résumé ou le numéro, mais jamais "Décision"
            raw_title = _extract_title(it)
            title = str(raw_title or resume or numero or f"Décision {len(out)+1}")[:120]  # fallback robuste

            url_decision = None
            if juri_id:
                url_decision = f"https://www.legifrance.gouv.fr/juri/id/{juri_id}"
            else:
                try:
                    q = requests.utils.quote(str(resume or numero or query))
                except Exception:
                    from urllib.parse import quote as uq
                    q = uq(str(resume or numero or query))
                url_decision = f"https://www.legifrance.gouv.fr/search/juri?tab_selection=juri&searchField=ALL&query={q}&page=1&init=true"

            year = datetime.now().year
            try:
                if isinstance(date_str, str) and '-' in date_str:
                    year = int(date_str.split('-')[0])
            except Exception:
                pass

            if not _is_authorized_domain(url_decision):
                continue

            # Extraire le texte des extraits et la solution depuis la réponse Légifrance
            raw_text = it.get('text', '') or ''
            # Nettoyer les balises <mark> et les marqueurs [...]
            import re as _re
            clean_text = _re.sub(r'<[^>]+>', '', raw_text).replace('[...]', '…').strip()
            solution = it.get('solution', '') or ''

            out.append({
                'title': title,
                'court': str(court or ''),
                'year': year,
                'url': url_decision,
                'summary': '',
                'date': str(date_str or ''),
                'solution': solution,
                'zones': {'expose_moyens': clean_text[:1500]} if clean_text else {},
                'highlights': '',
            })
        logger.info(f"✅ [Légifrance Search] {len(out)} résultats trouvés")
        return out
    except Exception as e:
        logger.warning(f"Legifrance search error: {e}")
    return []

def _judilibre_get_decision_text(decision_id: str, token: str) -> Dict[str, str]:
    """Récupère le texte complet d'une décision Judilibre par son identifiant JURITEXT."""
    try:
        base = JUDI_ENDPOINT or 'https://api.piste.gouv.fr/dila/judilibre/v1/search'
        decision_url = base.replace('/search', '/decision')
        headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json'}
        r = requests.get(decision_url, params={'id': decision_id}, headers=headers, timeout=8, proxies=_PROXIES)
        if not r.ok:
            return {}
        data = r.json() or {}
        zones = data.get('zones', {}) or {}
        result = {}
        for zone_key in ('expose_moyens', 'motivation', 'dispositif'):
            val = zones.get(zone_key, [])
            if isinstance(val, list):
                text = ' '.join(v for v in val if isinstance(v, str))
            elif isinstance(val, str):
                text = val
            else:
                text = ''
            if text:
                result[zone_key] = text[:1200]
        sol = data.get('solution', '') or data.get('solution_alt', '')
        if sol:
            result['solution'] = sol
        return result
    except Exception as e:
        logger.warning(f"[Judilibre GET decision] Erreur pour {decision_id}: {e}")
        return {}


def _judilibre_search(query: str, limit: int = 3, fetch_text: bool = True) -> List[Dict[str, Any]]:
    """
    Recherche via Judilibre (décisions judiciaires).
    `fetch_text=False` évite le téléchargement du texte complet de chaque
    décision — utile pour constituer un pool de candidats à re-classer
    (le texte des finalistes est récupéré ensuite via _judilibre_hydrate_text).
    """
    token = _get_judilibre_token()
    if not token:
        logger.info("🚫 [Judilibre Search] Pas de token, recherche annulée.")
        return []
    
    try:
        _require_requests()
        # L'endpoint peut être surchargé via .env
        url = JUDI_ENDPOINT or 'https://api.piste.gouv.fr/dila/judilibre/v1/search'
        headers = {
            'Authorization': f'Bearer {token}',
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        }
        
        # Corps de la requête simple pour Judilibre
        body = {
            "query": query,
            "page_size": limit,
            "page": 1,
            "operator": "AND"
        }

        logger.info(f"📦 [Judilibre Search] Envoi de la requête avec le corps: {json.dumps(body)}")
        r = requests.post(url, headers=headers, data=json.dumps(body), timeout=8, proxies=_PROXIES)
        
        if not r.ok:
            logger.warning(f"❌ [Judilibre Search] Échec: {r.status_code} {str(r.text)[:200]}")
            return []
        
        logger.info(f"✅ [Judilibre Search] Succès: {r.status_code}")
        data = r.json() or {}
        results = data.get('results', [])
        
        out: List[Dict[str, Any]] = []
        for res in results:
            if not isinstance(res, dict):
                continue
            
            # Mapping des champs Judilibre vers notre format standard
            title = res.get('title', '')
            court = res.get('jurisdiction', '')
            date_str = res.get('decision_date', '')
            year = datetime.now().year
            try:
                if isinstance(date_str, str) and '-' in date_str:
                    year = int(date_str.split('-')[0])
            except Exception:
                pass
            
            # Judilibre fournit souvent un lien direct
            url_decision = res.get('url', '')
            if not url_decision and res.get('id'):
                url_decision = f"https://www.legifrance.gouv.fr/juri/id/{res.get('id')}"

            if not url_decision or not _is_authorized_domain(url_decision):
                continue

            # Fetch du texte complet via l'endpoint /decision (différable)
            decision_id = res.get('id', '')
            if not decision_id:
                import re as _re
                m = _re.search(r'JURITEXT\w+', url_decision, _re.IGNORECASE)
                decision_id = m.group(0).upper() if m else ''

            decision_text = (
                _judilibre_get_decision_text(decision_id, token)
                if decision_id and fetch_text
                else {}
            )

            out.append({
                'id': decision_id,
                'title': title,
                'court': court,
                'year': year,
                'url': url_decision,
                'summary': res.get('summary', ''),
                'date': date_str,
                'relevanceScore': res.get('score', 0.8),
                'solution': decision_text.get('solution', res.get('solution', '') or res.get('solution_alt', '')),
                'zones': {k: decision_text[k] for k in ('expose_moyens', 'motivation', 'dispositif') if k in decision_text},
                'highlights': '',
            })
        logger.info(f"✅ [Judilibre Search] {len(out)} résultats trouvés")
        return out
    except Exception as e:
        logger.warning(f"Judilibre search error: {e}")
    return []


def _judilibre_hydrate_text(decision: Dict[str, Any]) -> Dict[str, Any]:
    """
    Complète une décision issue d'une recherche `fetch_text=False` avec le
    texte complet (solution + zones). No-op si déjà hydratée ou sans id.
    """
    if decision.get('zones'):
        return decision
    decision_id = decision.get('id') or ''
    if not decision_id:
        return decision
    token = _get_judilibre_token()
    if not token:
        return decision
    try:
        decision_text = _judilibre_get_decision_text(decision_id, token)
        if decision_text:
            out = dict(decision)
            out['solution'] = decision_text.get('solution', decision.get('solution', ''))
            out['zones'] = {
                k: decision_text[k]
                for k in ('expose_moyens', 'motivation', 'dispositif')
                if k in decision_text
            }
            return out
    except Exception as e:
        logger.warning(f"[Judilibre] Hydratation du texte impossible ({decision_id}): {e}")
    return decision
