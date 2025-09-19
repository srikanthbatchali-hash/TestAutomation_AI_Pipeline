from fastapi import FastAPI, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple, Optional
from pathlib import Path
import json
import re

import yaml
import pickle
import numpy as np
import chromadb

# ---- Optional Pyserini (BM25/RM3/Rocchio) ----
try:
    from pyserini.search.lucene import LuceneSearcher
    PYSERINI_OK = True
except Exception:
    PYSERINI_OK = False

# ----------------------------------------------
# Config & Models
# ----------------------------------------------
BASE = Path(__file__).resolve().parents[1]
CFG  = yaml.safe_load(open(BASE/"ingest"/"config.yaml","r",encoding="utf-8"))
PIPE = pickle.load(open(BASE/"models"/"tfidf_svd_384.pkl","rb"))

client = chromadb.HttpClient(
    host=CFG["chroma"]["host"], 
    port=int(CFG["chroma"]["port"]),
    ssl=bool(CFG["chroma"].get("ssl", False)),
    headers=CFG["chroma"].get("headers") or {},
)

# Optional app -> Pyserini index map in config.yaml (add this block if you have it)
# pyserini:
#   indexes:
#     claims: "C:/indexes/claims_lucene"
#     fraud:  "C:/indexes/fraud_lucene"
PYSERINI_IDX = (CFG.get("pyserini") or {}).get("indexes") or {}

# ----------------------------------------------
# Helpers
# ----------------------------------------------
STOP = set("""the a an and or of for to in on with by from as is are be was were it this that these those """.split())
DOMAIN_STOP = set(["claim","claims","policy","process","team","user"])  # extend with your own noisy terms

def tokenize(s: str) -> List[str]:
    return [w for w in re.findall(r"[A-Za-z0-9_]+", s.lower()) if w]

def rrf_union(rankings: List[Dict[str, int]], k: int = 60) -> List[Tuple[str, float]]:
    from collections import defaultdict
    scores = defaultdict(float)
    for ranks in rankings:
        for doc_id, r in ranks.items():
            scores[doc_id] += 1.0 / (k + r)
    return sorted(scores.items(), key=lambda x: -x[1])

def _pipe_transform(texts: List[str]) -> np.ndarray:
    m = PIPE.transform(texts)
    if hasattr(m, "toarray"):
        m = m.toarray()
    m = m.astype(np.float32)
    n = np.linalg.norm(m, axis=1, keepdims=True) + 1e-9
    return m / n

def qvec(q: str) -> List[float]:
    return _pipe_transform([q])[0].tolist()

def mmr(candidate_vecs, query_vec, top_n=8, lam=0.7):
    cand = np.array(candidate_vecs, dtype="float32")
    q = np.array(query_vec, dtype="float32")
    if cand.size == 0:
        return []
    sim_q = (cand @ q) / (np.linalg.norm(cand, axis=1)*np.linalg.norm(q)+1e-9)
    selected, rest = [], list(range(len(candidate_vecs)))
    while rest and len(selected) < top_n:
        if not selected:
            i = int(np.argmax(sim_q[rest])); selected.append(rest.pop(i)); continue
        sel = cand[selected]
        sim_div = cand[rest] @ sel.T
        sim_div = (sim_div / (np.linalg.norm(cand[rest],axis=1,keepdims=True)*np.linalg.norm(sel,axis=1)+1e-9)).max(axis=1)
        score = lam * sim_q[rest] - (1-lam) * sim_div
        j = int(np.argmax(score)); selected.append(rest.pop(j))
    return selected

def keyword_hits(text: str, terms: List[str]) -> set:
    tokens = set(tokenize(text or ""))
    return {t for t in terms if t in tokens}

def phrase_present(text: str, phrase: str, prox: int = 0) -> bool:
    words = tokenize(text or "")
    p = tokenize(phrase)
    if not p or len(words) < len(p): return False
    if prox <= 0:
        return (" ".join(p) in " ".join(words))
    # prox window: all phrase tokens appear within window size len(p)+prox
    idxs = [i for i,w in enumerate(words) if w == p[0]]
    for i in idxs:
        win = words[i:i+len(p)+prox]
        if all(any(w2==pw for w2 in win) for pw in p):
            return True
    return False

def coverage_score(doc_text: str, req_terms: List[str], req_phrases: List[str], proximity: int) -> Tuple[float, Dict[str, Any]]:
    hits = keyword_hits(doc_text, req_terms) if req_terms else set()
    ph_ok = {p: phrase_present(doc_text, p, prox=proximity) for p in req_phrases}
    cov = 0.0
    if req_terms:
        cov += len(hits) / max(1, len(req_terms))
    if req_phrases:
        cov += sum(1.0 if ok else 0.0 for ok in ph_ok.values()) / max(1, len(req_phrases))
    return cov, {"token_hits": sorted(hits), "phrase_hits": [k for k,v in ph_ok.items() if v]}

def pick_collection(app: str) -> str:
    m = { c["app"]: c["name"] for c in CFG["collections"] }
    return m.get(app, next(iter(m.values())))

def fetch_from_chroma_by_id(coll, did: str) -> Optional[Dict[str, Any]]:
    try:
        g = coll.get(ids=[did])
        if g.get("ids"):
            return {
                "id": g["ids"][0],
                "document": (g.get("documents") or [""])[0],
                "metadata": (g.get("metadatas") or [{}])[0],
            }
    except Exception:
        pass
    return None

# ----------------------------------------------
# Pyserini BM25 / RM3 / Rocchio
# ----------------------------------------------
def build_lucene_query(q: str, req_terms: List[str], req_phrases: List[str], proximity: int) -> str:
    """
    Build a Lucene query string with:
      - base tokens (stopwords filtered)
      - +required tokens
      - exact or slop phrases
    """
    base_terms = [w for w in tokenize(q) if w not in STOP and w not in DOMAIN_STOP][:8]
    parts: List[str] = []
    # base terms (soft)
    parts.extend(base_terms)
    # required tokens
    for t in req_terms:
        parts.append(f"+{t}")
    # phrases
    for p in req_phrases:
        toks = " ".join(tokenize(p))
        if not toks: 
            continue
        if proximity and proximity > 0:
            parts.append(f"+\"{toks}\"~{proximity}")
        else:
            parts.append(f"+\"{toks}\"")
    # fallback: if nothing, query everything
    return " ".join(parts) if parts else q or "*:*"

def pyserini_bm25(
    app_name: str,
    q: str,
    pool: int,
    req_terms: List[str],
    req_phrases: List[str],
    proximity: int,
    bm25_k1: float,
    bm25_b: float,
    use_rm3: bool,
    rm3_fb_terms: int,
    rm3_fb_docs: int,
    use_rocchio: bool,
    rocchio_alpha: float,
    rocchio_beta: float,
    rocchio_gamma: float
) -> Dict[str, int]:
    """
    Returns rank dict: {doc_id: 1-based-rank}
    """
    idx_path = PYSERINI_IDX.get(app_name)
    if not (PYSERINI_OK and idx_path and Path(idx_path).exists()):
        return {}

    searcher = LuceneSearcher(idx_path)
    # BM25 parameters
    if bm25_k1 is not None and bm25_b is not None:
        searcher.set_bm25(k1=float(bm25_k1), b=float(bm25_b))

    # Feedback models (exclusive—prefer RM3 if both toggled)
    if use_rm3:
        searcher.set_rm3(fb_terms=int(rm3_fb_terms), fb_docs=int(rm3_fb_docs))
    elif use_rocchio:
        searcher.set_rocchio(alpha=float(rocchio_alpha), beta=float(rocchio_beta), gamma=float(rocchio_gamma))

    qlucene = build_lucene_query(q, req_terms, req_phrases, proximity)
    hits = searcher.search(qlucene, k=max(pool, 100))  # generous pool

    ranks: Dict[str, int] = {}
    for i, h in enumerate(hits):
        # IMPORTANT: docid must match your Chroma id
        docid = h.docid
        ranks[docid] = i + 1
    return ranks

# ----------------------------------------------
# FastAPI
# ----------------------------------------------
app = FastAPI(title="Hybrid Retrieval (TF-IDF→SVD + Pyserini BM25/RM3 + RRF + MMR)")

class RetrieveResponse(BaseModel):
    query: str
    app: str
    top_k: int
    results: List[Dict[str, Any]]
    debug: Dict[str, Any]

@app.get("/retrieve", response_model=RetrieveResponse)
def retrieve(
    q: str = Query(..., description="user query"),
    app_name: str = Query("claims"),
    top_k: int = Query(8),
    pool: int = Query(50),
    signal: str = Query("hybrid", regex="^(hybrid|bm25|vector)$"),
    reembed_previews: bool = Query(True),

    # required tokens/phrases & proximity
    must: str = Query("", description="space/comma separated required tokens"),
    must_phrases: str = Query("", description='semicolon-separated phrases, e.g. "refund escalation; supervisor approval"'),
    min_hits: int = Query(0, description="min number of required tokens to appear; 0=all"),
    proximity: int = Query(0, description="phrase proximity window (0 = exact adjacency)"),

    # BM25 hyperparams
    bm25_k1: float = Query(0.9),
    bm25_b: float  = Query(0.4),

    # PRF toggles
    use_rm3: bool = Query(False),
    rm3_fb_terms: int = Query(10),
    rm3_fb_docs: int  = Query(10),

    use_rocchio: bool = Query(False),
    rocchio_alpha: float = Query(1.0),
    rocchio_beta: float  = Query(0.75),
    rocchio_gamma: float = Query(0.15)
):
    # ---- normalize requireds ----
    req_terms = [t for t in re.split(r"[,\s]+", must.strip()) if t]
    req_terms = [t.lower() for t in req_terms if t.lower() not in STOP and t.lower() not in DOMAIN_STOP]
    req_phrases = [p.strip() for p in must_phrases.split(";") if p.strip()]

    # ---- Vector search (Chroma) ----
    coll = client.get_or_create_collection(pick_collection(app_name))
    v_ids: List[str] = []; v_docs: List[str] = []; v_meta: List[Dict[str, Any]] = []; vranks: Dict[str,int] = {}
    if signal in ("hybrid", "vector"):
        qv = qvec(q)
        vres = coll.query(query_embeddings=[qv], n_results=max(pool, top_k*6), where={"app": app_name})
        v_ids  = vres.get("ids", [[]])[0] or []
        v_docs = vres.get("documents", [[]])[0] or []
        v_meta = vres.get("metadatas", [[]])[0] or []
        vranks = {v_ids[i]: i+1 for i in range(len(v_ids))}

    # ---- BM25 / RM3 / Rocchio via Pyserini ----
    branks: Dict[str, int] = {}
    if signal in ("hybrid", "bm25"):
        branks = pyserini_bm25(
            app_name=app_name, q=q, pool=pool,
            req_terms=req_terms, req_phrases=req_phrases, proximity=proximity,
            bm25_k1=bm25_k1, bm25_b=bm25_b,
            use_rm3=use_rm3, rm3_fb_terms=rm3_fb_terms, rm3_fb_docs=rm3_fb_docs,
            use_rocchio=use_rocchio, rocchio_alpha=rocchio_alpha, rocchio_beta=rocchio_beta, rocchio_gamma=rocchio_gamma
        )

    # ---- Fuse (union) with RRF ----
    fused_pairs = rrf_union(([vranks] if vranks else []) + ([branks] if branks else []), k=60)
    if not fused_pairs:
        return {
            "query": q, "app": app_name, "top_k": top_k,
            "results": [], 
            "debug": {
                "pool_sizes": {"vector": len(vranks), "bm25": len(branks), "fused": 0, "candidates": 0},
                "note": "No candidates (check Pyserini index path or Chroma collection).",
                "pyserini_ok": PYSERINI_OK, 
                "pyserini_index": PYSERINI_IDX.get(app_name)
            }
        }

    # Build candidate list, filling from Chroma for BM25-only ids
    id2i = {v_ids[i]: i for i in range(len(v_ids))}
    cand_ids: List[str] = []; cand_docs: List[str] = []; cand_meta: List[Dict[str,Any]] = []
    for doc_id, _score in fused_pairs:
        if len(cand_ids) >= max(pool, top_k*6): break
        if doc_id in id2i:
            j = id2i[doc_id]
            cand_ids.append(doc_id); cand_docs.append(v_docs[j]); cand_meta.append(v_meta[j])
        else:
            fetched = fetch_from_chroma_by_id(coll, doc_id)
            if fetched:
                cand_ids.append(fetched["id"]); cand_docs.append(fetched["document"]); cand_meta.append(fetched["metadata"])

    # ---- Keyword/phrase filtering + coverage scoring ----
    filt_ids, filt_docs, filt_meta, cov_scores, cov_dbg = [], [], [], [], []
    for did, doc, meta in zip(cand_ids, cand_docs, cand_meta):
        cov, dbg = coverage_score(doc or "", req_terms, req_phrases, proximity)
        enough_tokens = True
        if req_terms:
            hits = set(dbg.get("token_hits", []))
            need = (min_hits if min_hits > 0 else len(req_terms))
            enough_tokens = (len(hits) >= need)
        phrases_ok = True
        if req_phrases:
            phrases_ok = (len(dbg.get("phrase_hits", [])) == len(req_phrases))
        if enough_tokens and phrases_ok:
            filt_ids.append(did); filt_docs.append(doc); filt_meta.append(meta)
            cov_scores.append(cov); cov_dbg.append(dbg)

    # if filter too strict, fall back to candidates (but keep coverage for ranking)
    if not filt_ids:
        filt_ids, filt_docs, filt_meta = cand_ids, cand_docs, cand_meta
        cov_scores = [coverage_score(d or "", req_terms, req_phrases, proximity)[0] for d in filt_docs]
        cov_dbg    = [coverage_score(d or "", req_terms, req_phrases, proximity)[1] for d in filt_docs]

    # ---- Vectorize filtered docs and MMR with coverage blend ----
    if reembed_previews:
        cand_vecs = _pipe_transform([d or "" for d in filt_docs])
    else:
        cand_vecs = _pipe_transform([d or "" for d in filt_docs])

    qv_np = _pipe_transform([q])[0]
    sim = (cand_vecs @ qv_np) / (np.linalg.norm(cand_vecs, axis=1)*np.linalg.norm(qv_np)+1e-9)
    blended = 0.8*sim + 0.2*np.array(cov_scores, dtype="float32")

    # Take a shortlist by blended, then diversify with MMR
    order = np.argsort(-blended)[:max(top_k*3, 16)]
    mmr_idx = mmr(cand_vecs[order], qv_np, top_n=min(top_k, len(order)))
    keep_idx = [int(order[i]) for i in mmr_idx]

    results = []
    for i in keep_idx:
        results.append({
            "id": filt_ids[i],
            "document": filt_docs[i],
            "metadata": filt_meta[i],
            "debug": {
                "coverage": round(float(cov_scores[i]), 3),
                "token_hits": cov_dbg[i].get("token_hits", []),
                "phrase_hits": cov_dbg[i].get("phrase_hits", [])
            }
        })

    debug = {
        "pool_sizes": {
            "vector": len(vranks),
            "bm25": len(branks),
            "fused": len(fused_pairs),
            "candidates": len(cand_ids),
            "post_filter_kept": len(filt_ids)
        },
        "signal": signal,
        "required": {"terms": req_terms, "phrases": req_phrases, "min_hits": min_hits, "proximity": proximity},
        "pyserini_ok": PYSERINI_OK,
        "pyserini_index": PYSERINI_IDX.get(app_name),
        "bm25": {"k1": bm25_k1, "b": bm25_b, "rm3": use_rm3, "rm3_fb_terms": rm3_fb_terms, "rm3_fb_docs": rm3_fb_docs,
                 "rocchio": use_rocchio, "alpha": rocchio_alpha, "beta": rocchio_beta, "gamma": rocchio_gamma}
    }

    return {"query": q, "app": app_name, "top_k": top_k, "results": results, "debug": debug}
