from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional, Dict, Any, Set, Tuple
import os
import io
import base64
import binascii
import requests
import asyncio
from starlette.concurrency import run_in_threadpool
from datetime import datetime

#Max de requette en simultané
semaphore = asyncio.Semaphore(5)


IS_PROD = os.environ.get("IS_PROD", "false").lower() == "true"

if IS_PROD:
    from services.pdf_processing import (
        allowed_file,
        extract_clauses_ia_robuste,
        _extract_keywords_basic,
        _sanitize_query_text,
        _legifrance_search,
        _judilibre_search,
        _judilibre_hydrate_text,
        _openai_client,
    )
    from services.mise_en_forme import lire_document
    from legal_watch.router import router as legal_watch_router
else:
    from back.services.pdf_processing import (
        allowed_file,
        extract_clauses_ia_robuste,
        _extract_keywords_basic,
        _sanitize_query_text,
        _legifrance_search,
        _judilibre_search,
        _judilibre_hydrate_text,
        _openai_client,
    )
    from back.services.mise_en_forme import lire_document
    from back.legal_watch.router import router as legal_watch_router

from .logging_setup import setup_logging
import logging

setup_logging("INFO")

logger = logging.getLogger(__name__)

app = FastAPI()

# Veille juridique (ingestion Judilibre + enrichissement LLM — stateless)
app.include_router(legal_watch_router)

proxyUrl = ["http://localhost:3020", "https://proxy.lumenjuris.com"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=[proxyUrl],
    allow_methods=["*"],
    allow_headers=["*"],
) 



HF_TOKEN = os.environ.get("HF_TOKEN") #Hugging Face


class SearchRequest(BaseModel):
    query: str
    limit: int = 3


class JurisprudenceRequest(BaseModel):
    queries: List[str]
    # Description de la clause et du problème juridique identifié : active le
    # re-classement sémantique des décisions (recherche hybride).
    context: Optional[str] = None


class ClassifyVeilleRequest(BaseModel):
    articles: List[Dict[str, str]]  # [{title, description}, ...]


class AnalyzeClauseRequest(BaseModel):
    clauseText: str
    question: str
    clauseType: Optional[str] = None



class OpenAIRequestGpt5(BaseModel):
    prompt: str
    reasoning : str
    verbosity : str
    model: str = "gpt-5.2"



class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    context: Optional[str] = ""
    history: List[ChatMessage] = []
    model: str = "gpt-4o"


class OpenAIChatRequest(BaseModel):
    messages: List[Dict[str, str]]
    model: str = "gpt-4o"
    temperature: float = 0.3
    max_tokens: int = 800
    response_format: Optional[Dict[str, Any]] = None


class HFRequest(BaseModel):
    model: str
    inputs: str
    parameters: Optional[Dict[str, Any]] = None


def extract_token_usage(response: Any, model: str) -> Dict[str, Any]:
    usage = getattr(response, "usage", None)

    def usage_value(*keys: str) -> int:
        if not usage:
            return 0

        for key in keys:
            value = usage.get(key) if isinstance(usage, dict) else getattr(usage, key, None)
            if value is not None:
                return int(value)

        return 0

    return {
        "model": model,
        "input_tokens": usage_value("input_tokens", "prompt_tokens"),
        "output_tokens": usage_value("output_tokens", "completion_tokens"),
    }


@app.get("/health")
def healtMonitor():
    try:
        return {
            "status" : "OK"
        }
    except:
        return {
            "status" : "echec"
        }

@app.post("/extract-document-text")
async def extract_pdf_text(file: UploadFile = File(...), scan: bool = Form(False)):
    """Traite un fichier PDF ou Word et retourne le texte et les clauses."""
    if file.filename == "" or not allowed_file(file.filename):
        raise HTTPException(status_code=400, detail="Type de fichier non autorisé (PDF ou WORD requis)")


    content = await file.read()
    debut = datetime.now()
    document = await _lire(file.filename, content, scan)
    duree = (datetime.now() - debut).total_seconds()
    logger.info(f"[extraction] {file.filename} lu en {duree:.1f}s ({document.lecture}, {document.pages} page(s), {len(document.texte)} car.).")

    # Le texte et le HTML viennent du MÊME document propre (voir services/mise_en_forme.py) :
    # l'écran d'analyse affiche le HTML, l'import de modèle découpe le texte en paragraphes.
    return {
        "success": True,
        "text": document.texte,
        "html": document.html,
        "filename": file.filename,
        "extraction_method": document.methode,
        "lecture": document.lecture,
        "extraction_quality": "high" if len(document.texte) > 1000 else "medium",
        "pages": document.pages or 1,
        "is_protected": False,
    }


async def _lire(filename: str, content: bytes, scan: bool):
    """Lit un document ; les refus (ancien .doc, PDF protégé, document vide) partent en 422 avec un message lisible."""
    try:
        return await run_in_threadpool(lire_document, filename, content, scan)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        logger.error(f"[extraction] {filename} : {e}")
        raise HTTPException(status_code=503, detail=str(e))


class DocumentBase64Request(BaseModel):
    filename: str
    fileBase64: str
    scan: bool = False


@app.post("/extract-document-text-json")
async def extract_document_text_json(req: DocumentBase64Request):
    """Même traitement que /extract-document-text, mais le fichier arrive encodé en base64
    dans un corps JSON. Chez o2switch, un envoi multipart contenant un fichier est détourné
    avant d'atteindre l'application (réponse 404) : le JSON, lui, passe."""
    try:
        content = base64.b64decode(req.fileBase64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="Fichier base64 invalide")
    upload = UploadFile(file=io.BytesIO(content), filename=req.filename)
    return await extract_pdf_text(file=upload, scan=req.scan)


# ─────────────────────────────────────────────────────────────────────────────
# CONTRATHÈQUE — extraction des métadonnées d'un contrat (IA, "trust but verify")
#
# Renvoie pour chaque champ une valeur + un score de confiance auto-déclaré par
# le modèle (0..1). ATTENTION : ces scores ne sont PAS calibrés statistiquement,
# ils servent uniquement à orienter la revue humaine OBLIGATOIRE côté front.
# Aucune écriture en base ici — extraction pure.
# ─────────────────────────────────────────────────────────────────────────────

# Champs extraits (clés alignées sur le modèle Prisma Contract / ContractMetadataField)
CONTRACT_METADATA_KEYS = [
    "contract_type",       # type de contrat
    "counterparty_name",   # cocontractant
    "signature_date",      # AAAA-MM-JJ
    "effective_date",      # date d'effet AAAA-MM-JJ
    "end_date",            # date d'échéance AAAA-MM-JJ
    "duration_months",     # durée en mois (entier)
    "renewal_type",        # "none" | "tacit" | "express"
    "notice_period_days",  # préavis en jours (entier)
    "amount",              # montant (nombre)
    "currency",            # devise ISO (EUR, USD…)
    "governing_law",       # droit applicable
    "is_b2c",              # true si une des parties est un consommateur (loi Chatel)
    "sensitive_clauses",   # liste de clauses sensibles détectées
]



@app.get("/health")
def healtMonitor():
    try:
        return {
            "status" : "OK"
        }
    except:
        return {
            "status" : "echec"
        }

class ContractMetadataFromTextRequest(BaseModel):
    text: str


async def _lire_texte_contrat(filename: str, content: bytes, scan: bool) -> Tuple[str, str]:
    """Extrait le texte d'un contrat (Word ou PDF) et la méthode utilisée.

    Étape rapide (sans IA) : c'est elle qui alimente l'aperçu affiché
    immédiatement à l'utilisateur, avant l'analyse IA.
    """
    document = await _lire(filename, content, scan)
    return document.texte, document.methode


METADATA_MODEL = "gpt-5.2"


def _construire_prompt_metadonnees(texte: str) -> str:
    keys_desc = "\n".join(f"- {k}" for k in CONTRACT_METADATA_KEYS)
    return (
        "Tu es un juriste expert en droit français des contrats. Analyse le contrat ci-dessous "
        "et extrais ses métadonnées. Pour CHAQUE champ, fournis la valeur trouvée et un score de "
        "confiance entre 0 et 1 (1 = certitude, 0 = absent/illisible). Si un champ est absent, "
        "mets value=null et confidence=0.\n\n"
        "Champs à extraire :\n" + keys_desc + "\n\n"
        "Règles :\n"
        "- Dates au format AAAA-MM-JJ. Convertis les dates, durées et montants écrits en toutes lettres.\n"
        "- end_date : si elle n'est pas écrite mais que la date d'effet et la durée le sont, calcule-la.\n"
        "- renewal_type : 'tacit' (tacite reconduction), 'express' (reconduction expresse) ou 'none'.\n"
        "- is_b2c : true UNIQUEMENT si une partie est un particulier/consommateur (déclenche la loi Chatel).\n"
        "- duration_months et notice_period_days : entiers (préavis en jours : 1 mois = 30 jours).\n"
        "- amount : nombre sans symbole ; currency séparément.\n"
        "- sensitive_clauses : liste courte (exclusivité, non-concurrence, pénalités, résiliation unilatérale, "
        "limitation de responsabilité, cession, confidentialité…).\n"
        "- N'invente rien : un passage à compléter (pointillés, crochets, blanc) donne value=null.\n\n"
        "Réponds UNIQUEMENT en JSON strict de la forme :\n"
        '{ "fields": { "<clé>": { "value": <valeur ou null>, "confidence": <0..1> }, ... } }\n\n'
        f"Contrat :\n{texte}"
    )


def _normaliser_champs(parsed: Any) -> List[Dict[str, Any]]:
    """Remet les champs de l'IA dans l'ordre attendu, en bornant les scores."""
    raw_fields = parsed.get("fields", {}) if isinstance(parsed, dict) else {}
    fields = []
    for key in CONTRACT_METADATA_KEYS:
        entry = raw_fields.get(key) or {}
        value = entry.get("value") if isinstance(entry, dict) else entry
        confidence = entry.get("confidence") if isinstance(entry, dict) else None
        # sensitive_clauses peut être une liste : on la sérialise pour un stockage homogène
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value) if value else None
        try:
            confidence = float(confidence) if confidence is not None else 0.0
        except (TypeError, ValueError):
            confidence = 0.0
        fields.append({
            "field_key": key,
            "value": None if value in ("", None) else str(value),
            "confidence_score": max(0.0, min(1.0, confidence)),
        })
    return fields


async def _analyser_metadonnees_ia(texte: str) -> Tuple[List[Dict[str, Any]], Any]:
    """Appel IA d'extraction des métadonnées.

    Étape lente : le front la joue en tâche de fond pendant que l'utilisateur
    lit déjà le texte du contrat.
    """
    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service d'extraction IA non disponible")

    prompt = _construire_prompt_metadonnees(texte)

    # gpt-5.2 en réflexion « low » : gpt-4o-mini laissait des champs vides et se
    # trompait (durée « UN MOIS » lue 36 mois, échéance jamais calculée).
    def _call():
        return _openai_client.responses.create(
            model=METADATA_MODEL,
            input=prompt,
            reasoning={"effort": "low"},
            text={"format": {"type": "json_object"}},
        )

    debut = datetime.now()
    try:
        resp = await run_in_threadpool(_call)
        raw = resp.output_text or "{}"
        import json as _json
        parsed = _json.loads(raw)
    except Exception as e:
        logger.error(f"[metadonnees-contrat] Erreur OpenAI/JSON: {e}")
        raise HTTPException(status_code=500, detail="Échec de l'extraction des métadonnées.")

    duree = (datetime.now() - debut).total_seconds()
    logger.info(f"[metadonnees-contrat] IA terminée en {duree:.1f}s ({len(texte)} car. envoyés).")
    return _normaliser_champs(parsed), resp


@app.post("/extract-contract-text")
async def extract_contract_text(file: UploadFile = File(...), scan: bool = Form(False)):
    """Étape 1 : texte seul, sans IA. Permet d'afficher l'aperçu tout de suite."""
    if file.filename == "" or not allowed_file(file.filename):
        raise HTTPException(status_code=400, detail="Type de fichier non autorisé (PDF ou WORD requis)")

    content = await file.read()
    debut = datetime.now()
    texte, extraction_method = await _lire_texte_contrat(file.filename, content, scan)
    duree = (datetime.now() - debut).total_seconds()
    logger.info(f"[texte-contrat] {file.filename} lu en {duree:.1f}s ({len(texte)} car., {extraction_method}).")

    return {
        "success": True,
        "ocr_text": texte,
        "filename": file.filename,
        "extraction_method": extraction_method,
    }


@app.post("/extract-contract-metadata-from-text")
async def extract_contract_metadata_from_text(req: ContractMetadataFromTextRequest):
    """Étape 2 : métadonnées IA à partir d'un texte déjà extrait, sans relire le
    fichier. Appelée en tâche de fond pendant la revue humaine."""
    texte = (req.text or "").strip()
    if not texte:
        raise HTTPException(status_code=400, detail="Aucun texte de contrat fourni.")

    fields, resp = await _analyser_metadonnees_ia(texte)
    return {
        "success": True,
        "fields": fields,
        "openai_tokens": extract_token_usage(resp, METADATA_MODEL),
    }


@app.post("/extract-contract-metadata")
async def extract_contract_metadata(file: UploadFile = File(...), scan: bool = Form(False)):
    """Extraction complète en un appel (texte + IA). Conservée pour les appelants
    qui ne découpent pas les deux étapes."""
    if file.filename == "" or not allowed_file(file.filename):
        raise HTTPException(status_code=400, detail="Type de fichier non autorisé (PDF ou WORD requis)")

    content = await file.read()
    texte, extraction_method = await _lire_texte_contrat(file.filename, content, scan)
    fields, resp = await _analyser_metadonnees_ia(texte)

    return {
        "success": True,
        "fields": fields,
        "ocr_text": texte,
        "filename": file.filename,
        "extraction_method": extraction_method,
        "openai_tokens": extract_token_usage(resp, METADATA_MODEL),
    }


@app.post("/legifrance-search")
async def legifrance_search(req: SearchRequest):
    query = _sanitize_query_text((req.query or "").strip())
    limit = min(max(req.limit, 1), 10)
    if not query:
        raise HTTPException(status_code=400, detail="Aucun terme de recherche fourni.")
    resultats = _legifrance_search(query, limit=limit)
    return {"success": True, "query": query, "resultats": resultats}


_VEILLE_TAGS = [
    "Rupture", "Temps de travail", "Rémunération", "Santé/Sécurité",
    "Discipline", "Relations collectives", "Protection sociale", "Recrutement",
]

@app.post("/classify-veille")
async def classify_veille(req: ClassifyVeilleRequest):
    if not req.articles:
        return []
    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service IA non disponible")

    tag_list = ", ".join(_VEILLE_TAGS)
    lines = "\n".join(
        f"{i+1}. \"{a.get('title','')}\" — {a.get('description','')[:150]}"
        for i, a in enumerate(req.articles)
    )
    prompt = (
        f"Tu es un expert RH et droit du travail français.\n"
        f"Classe chaque actualité dans l'une de ces catégories : {tag_list}.\n"
        f"Réponds \"null\" si l'actualité n'est pas directement liée au droit du travail ou aux RH, "
        f"OU si elle ne s'applique pas concrètement à un employeur ou un service RH "
        f"(ex : politique étrangère, défense, environnement, textes sans impact employeur).\n"
        f"Réponds UNIQUEMENT avec une ligne par actualité, format exact :\n"
        f"1. <catégorie ou null>\n2. <catégorie ou null>\n...\n\n"
        f"Actualités :\n{lines}"
    )

    def _call():
        return _openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=len(req.articles) * 15,
        )

    resp = await run_in_threadpool(_call)
    output = (resp.choices[0].message.content or "").strip()

    results = [None] * len(req.articles)
    for line in output.splitlines():
        m = __import__("re").match(r"^(\d+)\.\s*(.+)$", line.strip())
        if not m:
            continue
        idx = int(m.group(1)) - 1
        val = m.group(2).strip()
        if 0 <= idx < len(req.articles) and val in _VEILLE_TAGS:
            results[idx] = val

    return results


def _structure_decision_summary(decision: Dict[str, Any]) -> Dict[str, Any]:
    """Enrichit une décision avec un résumé structuré (litige + résultat) via OpenAI."""
    if not _openai_client:
        return decision

    title = decision.get("title", "")
    court = decision.get("court", "")
    date = decision.get("date", "")
    summary = decision.get("summary", "")
    solution = decision.get("solution", "")
    zones = decision.get("zones", {}) or {}
    highlights = decision.get("highlights", "")

    # Assembler tout le contenu textuel disponible
    content_parts = []
    if zones.get("expose_moyens"):
        content_parts.append(f"Exposé des moyens : {zones['expose_moyens']}")
    if zones.get("motivation"):
        content_parts.append(f"Motivation : {zones['motivation']}")
    if zones.get("dispositif"):
        content_parts.append(f"Dispositif : {zones['dispositif']}")
    if highlights:
        content_parts.append(f"Extraits pertinents : {highlights}")
    if summary:
        content_parts.append(f"Résumé : {summary}")

    # Si aucun contenu réel disponible, ne pas appeler le LLM (évite les hallucinations)
    has_content = bool(content_parts or solution)
    if not has_content:
        return decision

    context_lines = []
    if title:
        context_lines.append(f"Décision : {title}")
    if court:
        context_lines.append(f"Juridiction : {court}")
    if date:
        context_lines.append(f"Date : {date}")
    if solution:
        context_lines.append(f"Solution : {solution}")
    context_lines.extend(content_parts)

    prompt = (
        "Tu es un juriste expert en droit français. Analyse cette décision de justice et rédige deux phrases précises :\n"
        "1. LITIGE : Décris factuellement le litige (quelles parties, quel contrat ou situation, quel désaccord précis).\n"
        "2. RESULTAT : Indique le résultat concret (cassation/rejet/irrecevabilité, au profit de qui, pour quel motif juridique).\n\n"
        "Sois factuel et précis. N'invente rien qui ne soit pas dans le texte. "
        "Format STRICT (deux lignes) :\n"
        "LITIGE: <phrase factuelle>\n"
        "RESULTAT: <phrase factuelle>\n\n"
        + "\n".join(context_lines)
    )

    try:
        resp = _openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=250,
        )
        text = resp.choices[0].message.content.strip()
        # Normaliser : séparer LITIGE: et RESULTAT: même s'ils sont sur la même ligne
        import re as _re
        litige_m = _re.search(r'LITIGE:\s*(.+?)(?=RESULTAT:|$)', text, _re.DOTALL)
        resultat_m = _re.search(r'RESULTAT:\s*(.+?)$', text, _re.DOTALL)
        if litige_m:
            decision["litige"] = litige_m.group(1).strip()
        if resultat_m:
            decision["resultat"] = resultat_m.group(1).strip()
    except Exception as e:
        logger.warning(f"[structure_decision_summary] Erreur OpenAI: {e}")

    return decision


def _candidate_text_for_rerank(decision: Dict[str, Any]) -> str:
    """Texte représentatif d'une décision pour le calcul de similarité."""
    zones = decision.get("zones") or {}
    parts = [
        str(decision.get("title") or ""),
        str(decision.get("summary") or ""),
        str(decision.get("solution") or ""),
        str(zones.get("motivation") or "")[:1200],
    ]
    return "\n".join(p for p in parts if p.strip())[:2000]


def _semantic_rerank(context: str, candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Re-classe les décisions par similarité sémantique avec le problème juridique
    (embeddings OpenAI + cosinus). En cas d'échec, renvoie l'ordre d'origine.
    """
    if not _openai_client or not context.strip() or len(candidates) < 2:
        return candidates
    try:
        inputs = [context[:2000]] + [_candidate_text_for_rerank(c) for c in candidates]
        resp = _openai_client.embeddings.create(model="text-embedding-3-small", input=inputs)
        vectors = [d.embedding for d in resp.data]
        ref = vectors[0]

        def cosine(a: List[float], b: List[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            na = sum(x * x for x in a) ** 0.5
            nb = sum(y * y for y in b) ** 0.5
            return dot / (na * nb) if na and nb else 0.0

        scored = []
        for cand, vec in zip(candidates, vectors[1:]):
            sim = cosine(ref, vec)
            cand = dict(cand)
            cand["relevanceScore"] = round(sim, 3)
            scored.append((sim, cand))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [c for _, c in scored]
    except Exception as e:  # pragma: no cover — repli silencieux
        logger.warning(f"[jurisprudence] Rerank sémantique indisponible: {e}")
        return candidates


@app.post("/jurisprudence")
async def jurisprudence(req: JurisprudenceRequest):
    if not req.queries:
        raise HTTPException(status_code=400, detail="Requête invalide, 'queries' manquant.")

    # ── Recherche hybride ──────────────────────────────────────────────────
    # 1) Rappel lexical élargi : jusqu'à 3 requêtes complémentaires en parallèle
    #    (Judilibre), pool de candidats plus large que le besoin final.
    queries = [q for q in (req.queries or []) if isinstance(q, str) and q.strip()][:3]
    pool_size = 6 if req.context else 3
    # fetch_text=False : pool léger (métadonnées seulement) — le texte complet
    # n'est téléchargé que pour les 3 décisions retenues (hydratation ci-dessous).
    results_per_query = await asyncio.gather(
        *[run_in_threadpool(_judilibre_search, q, pool_size, False) for q in queries]
    )

    all_results: List[Dict[str, Any]] = []
    seen_urls: Set[str] = set()
    for res_list in results_per_query:
        for res in res_list or []:
            url = res.get("url")
            if url and url not in seen_urls:
                all_results.append(res)
                seen_urls.add(url)

    # Complément Legifrance si le rappel est trop pauvre.
    if len(all_results) < 3 and queries:
        legifrance_results = await run_in_threadpool(_legifrance_search, queries[0], 3)
        for res in legifrance_results or []:
            url = res.get("url")
            if url and url not in seen_urls:
                all_results.append(res)
                seen_urls.add(url)

    # 2) Re-classement sémantique : les candidats sont triés par similarité
    #    avec la clause et le problème juridique identifié (si fournis).
    if req.context:
        all_results = await run_in_threadpool(_semantic_rerank, req.context, all_results)

    # 3) Hydratation : texte complet (solution + motivation) pour les finalistes
    #    uniquement, puis enrichissement LITIGE/RESULTAT.
    decisions = await asyncio.gather(
        *[run_in_threadpool(_judilibre_hydrate_text, d) for d in all_results[:3]]
    )
    enriched = await asyncio.gather(
        *[run_in_threadpool(_structure_decision_summary, d) for d in decisions]
    )
    return list(enriched)


@app.post("/analyze-clause")
async def analyze_clause(req: AnalyzeClauseRequest):
    if not req.clauseText or not req.question:
        raise HTTPException(status_code=400, detail="Texte de clause ou question manquant")
    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service d'analyse non disponible")
    prompt = f"""Tu es un expert juridique français spécialisé en droit des contrats.

Contexte : Analyse d'une {req.clauseType or 'clause contractuelle'}

Clause à analyser :
{req.clauseText[:2000]}

Question : {req.question}

Réponds de manière claire, structurée et professionnelle en 3-4 paragraphes maximum.
Si la question concerne les risques, identifie les principaux points d'attention juridiques.
Si la question demande des améliorations, propose des reformulations concrètes."""
    response = _openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
        max_tokens=500,
    )
    answer = response.choices[0].message.content.strip()
    return {
        "success": True,
        "answer": answer,
        "question": req.question,
        "openai_tokens": extract_token_usage(response, "gpt-4o"),
    }














LEGAL_KEYWORDS = {
    "droit", "juridique", "loi", "code", "contrat", "clause",
    "convention", "collective", "prud'homme", "prudhomme",
    "tribunal", "justice", "juge", "avocat", "notaire",
    "société", "sas", "sarl", "entreprise", "association",
    "licenciement", "cdi", "cdd", "rupture", "salarié",
    "employeur", "travail", "bail", "location", "propriété",
    "succession", "héritage", "donation", "divorce",
    "responsabilité", "obligation", "facture", "tva",
    "impôt", "fiscal", "rgpd", "cnil"
}

async def is_legal_question(message: str) -> bool:
    """
    Vérifie si une question est dans la thematique du juridique pour le chat juridique.
    """

    lower = message.lower()

    # Cas évident : présence d'un mot-clé juridique
    if any(keyword in lower for keyword in LEGAL_KEYWORDS):
        return True

    # Cas ambigu : classification GPT
    response = await run_in_threadpool(
        lambda: _openai_client.responses.create(
            model="gpt-5.4-nano",
            input=[
                {
                    "role": "system",
                    "content": """
                            Tu es un classificateur.

                            Réponds UNIQUEMENT par :
                            LEGAL
                            ou
                            NOT_LEGAL

                            Une question est LEGAL si elle concerne notamment :
                            - le droit
                            - les contrats
                            - les entreprises
                            - les obligations
                            - les conventions collectives
                            - les RH
                            - la fiscalité
                            - la conformité
                            - les administrations
                            - les litiges
                            - les procédures
                            - les réglementations françaises

                            Tout le reste est NOT_LEGAL.
                            """,
                },
                {
                    "role": "user",
                    "content": message,
                },
            ],
        )
    )

    return response.output_text.strip().upper() == "LEGAL"


@app.post("/chat")
async def chat(req: ChatRequest):
    if not req.message:
        raise HTTPException(status_code=400, detail="Message manquant")

    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service de chat non disponible")

    # Vérification du domaine
    if not await is_legal_question(req.message):
        return {
            "success": False,
            "response": (
                "Je suis un assistant spécialisé dans le domaine juridique français et "
                "ne peux répondre qu'aux questions ayant un lien avec le droit."
            ),
        }

    messages = [
        {
            "role": "system",
            "content": """
Tu es un assistant juridique expert en droit français.

Tu réponds uniquement aux questions ayant un lien direct avec le droit français,
les contrats, les entreprises, les conventions collectives, les obligations
légales, la conformité, les procédures ou la réglementation.

Si une question n'est pas juridique, réponds exactement :

"Je suis un assistant spécialisé dans le domaine juridique français et ne peux répondre qu'aux questions ayant un lien avec le droit."

Tu ne dois jamais répondre à une question hors de ce périmètre.

Tes réponses doivent être :
- précises ;
- pédagogiques ;
- adaptées au droit français ;
- nuancées lorsqu'il existe plusieurs situations possibles.

Lorsque cela est pertinent, précise qu'un professionnel du droit peut être nécessaire.
""",
        }
    ]

    if req.context:
        messages.append({
            "role": "system",
            "content": f"Contexte du document analysé :\n{req.context[:2000]}"
        })

    for h in req.history[-10:]:
        if h.role and h.content:
            messages.append({
                "role": h.role,
                "content": h.content,
            })

    messages.append({
        "role": "user",
        "content": req.message,
    })

    if req.model in {"gpt-5.2", "gpt-5.4-nano"}:
        response = await run_in_threadpool(
            lambda: _openai_client.responses.create(
                model=req.model,
                input=messages,
                reasoning={"effort": "medium"},
                text={"verbosity": "medium"},
            )
        )

        return {
            "success": True,
            "response": response.output_text.strip(),
            "openai_tokens": extract_token_usage(response, req.model),
        }

    response = await run_in_threadpool(
        lambda: _openai_client.chat.completions.create(
            model=req.model,
            messages=messages,
            temperature=0.7,
            max_tokens=800,
        )
    )

    return {
        "success": True,
        "response": response.choices[0].message.content.strip(),
        "openai_tokens": extract_token_usage(response, req.model),
    }














@app.post("/openai-chat")
async def openai_chat(req: OpenAIChatRequest):
    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service OpenAI non configuré")
    params = {
        "model": req.model,
        "messages": req.messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    }
    if req.response_format:
        params["response_format"] = req.response_format
    try:
        response = _openai_client.chat.completions.create(**params)
        content = response.choices[0].message.content
        return {
            "content": content,
            "openai_tokens": extract_token_usage(response, req.model),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))





@app.post("/openai-chat-5")
async def openai_chat52(req:OpenAIRequestGpt5):

    if not _openai_client:
        raise HTTPException(status_code=503, detail="Service OpenAI non configuré")

    allowed_models = {"gpt-5.2", "gpt-5.4-nano"}
    if req.model not in allowed_models:
        raise HTTPException(status_code=400, detail=f"Modèle OpenAI non autorisé: {req.model}")
    
    try:
        #construction des parametres
        params = {
            "model": req.model,
            "input" : [
                {"role": "system", "content": "Tu es un expert en droit français, spécialisé en contrats et analyse de clauses à risque."},
                {"role": "user", "content": req.prompt}
            ],
            "reasoning" : { "effort" : req.reasoning},
            "text" : { "verbosity" : req.verbosity}
        }
        #Set temperature et top_p si on n'active pas le reasoning
        if req.reasoning == "none":
            params["temperature"] = 0.15
            params["top_p"] = 0.95

        async with semaphore:
        #call openai
            response = await run_in_threadpool(lambda: _openai_client.responses.create(**params))   
            
        #Renvois la réponse  
        content = response.output_text
        return {
            "content": content,
            "openai_tokens": extract_token_usage(response, req.model),
        }
    except Exception as e:
        import traceback
        print("❌ Erreur OpenAI:", type(e), e)
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))







@app.post("/huggingface-generate")
async def huggingface_generate(req: HFRequest):
    if not HF_TOKEN:
        raise HTTPException(status_code=503, detail="Service HuggingFace non configuré")
    url = f"https://api-inference.huggingface.co/models/{req.model}"
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    payload = {"inputs": req.inputs}
    if req.parameters:
        payload["parameters"] = req.parameters
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=60)
        r.raise_for_status()
        data = r.json()
        text = ""
        if isinstance(data, list) and data:
            text = data[0].get("generated_text", "")
        elif isinstance(data, dict):
            text = data.get("generated_text", "")
        return {"generated_text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/summarize-case")
async def summarize_case():
    return JSONResponse({"success": False, "summary": "", "error": "Non implémenté"}, status_code=501)

@app.get("/")
async def root():
    logger.info("info test")
    logger.warning("warning test")
    logger.error("error test")
    return {"status": "ok"}


# ════════════════════════════════════════════════════════════════════════════
# MODULE NÉGOCIATION — diff structuré clause par clause (déterministe, sans IA)
# Appelé par le proxy via /api/negotiation-diff. Additif, isolé.
# ════════════════════════════════════════════════════════════════════════════

class NegotiationDiffRequest(BaseModel):
    leftText: str
    rightText: str


def _segment_clauses(text: str) -> List[Dict[str, str]]:
    """Découpe un contrat en clauses par en-têtes 'Article N' (fallback : paragraphes)."""
    import re
    lines = (text or "").split("\n")
    clauses: List[Dict[str, str]] = []
    current = {"ref": "preambule", "title": "Préambule", "body": []}
    header_re = re.compile(r"^\s*(article\s+\d+|art\.?\s*\d+)\b.*", re.IGNORECASE)
    for ln in lines:
        if header_re.match(ln):
            if current["body"] or current["ref"] != "preambule":
                current["body"] = "\n".join(current["body"]).strip()
                clauses.append(current)
            ref = ln.strip()
            current = {"ref": ref.lower()[:60], "title": ref.strip(), "body": []}
        else:
            current["body"].append(ln)
    current["body"] = "\n".join(current["body"]).strip()
    clauses.append(current)
    return [c for c in clauses if c["body"] or c["ref"] != "preambule"]


def _line_diff(a: str, b: str) -> List[Dict[str, Any]]:
    """Diff ligne à ligne via difflib (added / removed / equal)."""
    import difflib
    al, bl = a.split("\n"), b.split("\n")
    sm = difflib.SequenceMatcher(a=al, b=bl, autojunk=False)
    out: List[Dict[str, Any]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for line in al[i1:i2]:
                out.append({"type": "equal", "text": line})
        elif tag == "delete":
            for line in al[i1:i2]:
                out.append({"type": "removed", "text": line})
        elif tag == "insert":
            for line in bl[j1:j2]:
                out.append({"type": "added", "text": line})
        elif tag == "replace":
            for line in al[i1:i2]:
                out.append({"type": "removed", "text": line})
            for line in bl[j1:j2]:
                out.append({"type": "added", "text": line})
    return out


@app.post("/negotiation-diff")
async def negotiation_diff(req: NegotiationDiffRequest):
    """Diff structuré clause par clause entre deux versions d'un contrat."""
    left = _segment_clauses(req.leftText)
    right = _segment_clauses(req.rightText)

    # Alignement des clauses par titre normalisé.
    def norm(t: str) -> str:
        return " ".join(t.lower().split())[:60]

    right_by_key = {norm(c["title"]): c for c in right}
    left_keys = set()
    clauses_out: List[Dict[str, Any]] = []
    added = removed = modified = unchanged = 0

    for lc in left:
        key = norm(lc["title"])
        left_keys.add(key)
        rc = right_by_key.get(key)
        if rc is None:
            removed += 1
            clauses_out.append({"ref": lc["ref"], "title": lc["title"], "status": "removed", "lines": _line_diff(lc["body"], "")})
        elif rc["body"].strip() == lc["body"].strip():
            unchanged += 1
            clauses_out.append({"ref": lc["ref"], "title": lc["title"], "status": "unchanged", "lines": []})
        else:
            modified += 1
            clauses_out.append({"ref": lc["ref"], "title": lc["title"], "status": "modified", "lines": _line_diff(lc["body"], rc["body"])})

    for rc in right:
        if norm(rc["title"]) not in left_keys:
            added += 1
            clauses_out.append({"ref": rc["ref"], "title": rc["title"], "status": "added", "lines": _line_diff("", rc["body"])})

    return {
        "success": True,
        "clauses": clauses_out,
        "stats": {"added": added, "removed": removed, "modified": modified, "unchanged": unchanged},
    }
