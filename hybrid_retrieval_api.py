from fastapi import FastAPI, Query
from pydantic import BaseModel
from typing import List, Dict, Any, Tuple
from pathlib import Path
import json, re, pickle, yaml, numpy as np
import chromadb
from whoosh import index as wx, qparser, query as Q, spans as S
import faiss

BASE = Path(__file__).resolve().parents[1]
CFG  = yaml.safe_load(open(BASE/"ingest"/"config.yaml","r",encoding="utf-8"))

# --- Embedder (TF-IDF→SVD) ---
PIPE = pickle.load(open(BASE/"models"/"tfidf_svd_384.pkl","rb"))
def _pipe_transform(texts: List[str]) -> np.ndarray:
    m = PIPE.transform(texts); m = m.toarray() if hasattr(m,"toarray") else m
    m = m.astype(np.float32); n = np.linalg.norm(m,axis=1,keepdims=True)+1e-9
    return m / n

# --- Chroma client ---
client = chromadb.HttpClient(
    host=CFG["chroma"]["host"], port=int(CFG["chroma"]["port"]),
    ssl=bool(CFG["chroma"].get("ssl", False)), headers=CFG["chroma"].get("headers") or {}
)

# --- FAISS: load per app ---
FAISS_DIR = BASE / "faiss"
FAISS_IDX: Dict[str, faiss.Index] = {}
FAISS_IDS: Dict[str, List[str]] = {}

def load_faiss_for_app(app: str):
    if app in FAISS_IDX: return
    idx_p = FAISS_DIR / f"{app}.faiss"
    ids_p = FAISS_DIR / f"{app}_ids.json"
    if idx_p.exists() and ids_p.exists():
        FAISS_IDX[app] = faiss.read_index(str(idx_p))
        FAISS_IDS[app] = json.load(open(ids_p, "r", encoding="utf-8"))
    else:
        FAISS_IDX[app] = None
        FAISS_IDS[app] = []

# --- Whoosh index dir ---
IX_DIR = BASE / "data" / "whoosh"

STOP = set("""the a an and or of for to in on with by from as is are be was were it this that these those""".split())
DOMAIN_STOP = set(["claim","claims","policy","process","team","user"])  # extend if noisy

def pick_collection(app: str) -> str:
    m = { c["app"]: c["name"] for c in CFG["collections"] }
    return m.get(app, next(iter(m.values())))

def tokenize(s: str) -> List[str]:
    return [w for w in re.findall(r"[A-Za-z0-9_]+", s.lower()) if w]

def rrf_union(rankings: List[Dict[str,int]], k: int = 60):
    from collections import defaultdict
    s=defaultdict(float)
    for ranks in rankings:
        for did, r in ranks.items(): s[did]+=1.0/(k+r)
    return sorted(s.items(), key=lambda x:-x[1])

def mmr(candidate_vecs, query_vec, top_n=8, lam=0.7):
    cand = np.array(candidate_vecs, dtype="float32")
    q = np.array(query_vec, dtype="float32")
    if cand.size == 0: return []
    sim_q=(cand@q)/(np.linalg.norm(cand,axis=1)*np.linalg.norm(q)+1e-9)
    selected,rest=[],list(range(len(candidate_vecs)))
    while rest and len(selected)<top_n:
        if not selected:
            i=int(np.argmax(sim_q[rest])); selected.append(rest.pop(i)); continue
        sel=cand[selected]
        sim_div=cand[rest]@sel.T
        sim_div=(sim_div/(np.linalg.norm(cand[rest],axis=1,keepdims=True)*np.linalg.norm(sel,axis=1)+1e-9)).max(axis=1)
        score=lam*sim_q[rest]-(1-lam)*sim_div
        j=int(np.argmax(score)); selected.append(rest.pop(j))
    return selected

def keyword_hits(text: str, terms: List[str]) -> set:
    return set(tokenize(text or "")).intersection(set(terms))

def phrase_present(text: str, phrase: str, prox: int = 0) -> bool:
    words=tokenize(text or ""); p=tokenize(phrase)
    if not p or len(words)<len(p): return False
    if prox<=0: return (" ".join(p) in " ".join(words))
    idxs=[i for i,w in enumerate(words) if w==p[0]]
    for i in idxs:
        win=words[i:i+len(p)+prox]
        if all(any(w2==pw for w2 in win) for pw in p): return True
    return False

def coverage_score(doc_text: str, req_terms: List[str], req_phrases: List[str], proximity: int):
    hits = keyword_hits(doc_text, req_terms) if req_terms else set()
    ph_ok = {p: phrase_present(doc_text, p, prox=proximity) for p in req_phrases}
    cov = 0.0
    if req_terms:   cov += len(hits)/max(1,len(req_terms))
    if req_phrases: cov += sum(1.0 if ok else 0.0 for ok in ph_ok.values())/max(1,len(req_phrases))
    return cov, {"token_hits": sorted(hits), "phrase_hits": [k for k,v in ph_ok.items() if v]}

app = FastAPI(title="Hybrid Retrieval (FAISS + Whoosh + Chroma)")

class RetrieveResponse(BaseModel):
    query: str
    app: str
    top_k: int
    results: List[Dict[str, Any]]
    debug: Dict[str, Any]

@app.get("/retrieve", response_model=RetrieveResponse)
def retrieve(
    q: str = Query(...),
    app_name: str = Query("claims"),
    top_k: int = Query(8),
    pool: int = Query(80),

    signal: str = Query("hybrid", regex="^(hybrid|faiss|bm25|chroma)$"),
    reembed_previews: bool = Query(True),

    must: str = Query("", description="space/comma separated required tokens"),
    must_phrases: str = Query("", description='semicolon-separated phrases, e.g. "refund escalation; supervisor approval"'),
    min_hits: int = Query(0, description="minimum number of required tokens (0=all)"),
    proximity: int = Query(0, description="phrase proximity window (0=exact)")
):
    # normalize requireds
    req_terms = [t for t in re.split(r"[,\s]+", must.strip()) if t]
    req_terms = [t.lower() for t in req_terms if t.lower() not in STOP and t.lower() not in DOMAIN_STOP]
    req_phrases = [p.strip() for p in must_phrases.split(";") if p.strip()]

    # prepare holders
    vranks: Dict[str,int] = {}     # vector ranks (FAISS or Chroma)
    branks: Dict[str,int] = {}     # BM25 ranks
    cand_ids: List[str] = []
    cand_docs: List[str] = []
    cand_meta: List[Dict[str,Any]] = []

    coll = client.get_or_create_collection(pick_collection(app_name))

    # --- Vector side: FAISS or Chroma ---
    if signal in ("hybrid","faiss","chroma"):
        if signal in ("hybrid","faiss"):
            load_faiss_for_app(app_name)
            idx = FAISS_IDX.get(app_name); idlist = FAISS_IDS.get(app_name, [])
            if idx is not None and idlist:
                qv = _pipe_transform([q])
                D,I = idx.search(qv, max(pool, top_k*6))
                for rank, pos in enumerate(I[0].tolist(), start=1):
                    if pos == -1: continue
                    did = idlist[pos]
                    vranks[did] = rank
        if signal == "chroma":
            qv = _pipe_transform([q])[0].tolist()
            vres = coll.query(query_embeddings=[qv], n_results=max(pool, top_k*6), where={"app": app_name})
            v_ids = vres.get("ids",[[]])[0] or []
            vranks = {v_ids[i]: i+1 for i in range(len(v_ids))}

    # --- BM25 (Whoosh) ---
    if signal in ("hybrid","bm25"):
        ixp = IX_DIR / app_name
        if ixp.exists():
            with wx.open_dir(ixp).searcher() as s:
                # Build an AND query with optional proximity phrases
                clauses: List[Q.Query] = []
                base_terms = [w for w in tokenize(q) if w not in STOP|DOMAIN_STOP][:8]
                for w in base_terms: clauses.append(Q.Term("text", w))
                for t in req_terms:  clauses.append(Q.Term("text", t))
                for phr in req_phrases:
                    toks = tokenize(phr)
                    if toks:
                        if proximity and proximity>0:
                            clauses.append(S.SpanNear(*(Q.Term("text", x) for x in toks), slop=proximity))
                        else:
                            clauses.append(Q.Phrase("text", toks))
                qobj = Q.And(clauses) if clauses else Q.Every()
                bres = s.search(qobj, limit=max(pool, top_k*6))
                branks = { r["doc_id"]: i+1 for i,r in enumerate(bres) }

    # --- Fuse candidates via RRF (union) ---
    fused = rrf_union(([vranks] if vranks else []) + ([branks] if branks else []), k=60)
    if not fused:
        return {
            "query": q, "app": app_name, "top_k": top_k,
            "results": [], "debug": {
                "pool_sizes": {"vector": len(vranks), "bm25": len(branks), "fused": 0, "candidates": 0},
                "faiss_loaded": FAISS_IDX.get(app_name) is not None,
                "faiss_ids": len(FAISS_IDS.get(app_name, []))
            }
        }

    # materialize docs/metas from Chroma
    # take union top-N
    want_ids = [did for did,_ in fused[:max(pool, top_k*6)]]
    # Chroma may return in different order; request in slices then reorder
    got = coll.get(ids=want_ids)
    id2doc = {i:d for i,d in zip(got.get("ids",[]), got.get("documents",[]))}
    id2meta= {i:m for i,m in zip(got.get("ids",[]), got.get("metadatas",[]))}
    for did in want_ids:
        if did in id2doc:
            cand_ids.append(did)
            cand_docs.append(id2doc[did])
            cand_meta.append(id2meta[did])

    # --- Keyword/phrase filter & coverage ---
    req_need = (min_hits if min_hits>0 else len(req_terms))
    filt_ids, filt_docs, filt_meta, cov_scores, cov_dbg = [], [], [], [], []
    for did, doc, meta in zip(cand_ids, cand_docs, cand_meta):
        cov, dbg = coverage_score(doc or "", req_terms, req_phrases, proximity)
        enough_tokens = True
        if req_terms:
            hits = set(dbg.get("token_hits", []))
            enough_tokens = (len(hits) >= req_need)
        phrases_ok = True
        if req_phrases:
            phrases_ok = (len(dbg.get("phrase_hits", [])) == len(req_phrases))
        if enough_tokens and phrases_ok:
            filt_ids.append(did); filt_docs.append(doc); filt_meta.append(meta)
            cov_scores.append(cov); cov_dbg.append(dbg)
    if not filt_ids:
        # fall back without hard filter
        filt_ids, filt_docs, filt_meta = cand_ids, cand_docs, cand_meta
        for d in filt_docs:
            sc, db = coverage_score(d or "", req_terms, req_phrases, proximity)
            cov_scores.append(sc); cov_dbg.append(db)

    # --- Vectorize shortlist & MMR with coverage blend ---
    cand_vecs = _pipe_transform([d or "" for d in filt_docs])  # preview re-embed
    qv_np = _pipe_transform([q])[0]
    sim = (cand_vecs @ qv_np) / (np.linalg.norm(cand_vecs,axis=1)*np.linalg.norm(qv_np)+1e-9)
    blended = 0.8*sim + 0.2*np.array(cov_scores, dtype="float32")
    order = np.argsort(-blended)[:max(top_k*3, 16)]
    mmr_idx = mmr(cand_vecs[order], qv_np, top_n=min(top_k, len(order)))
    keep = [int(order[i]) for i in mmr_idx]

    results = []
    for i in keep:
        results.append({
            "id": filt_ids[i],
            "document": filt_docs[i],
            "metadata": filt_meta[i],
            "debug": {
                "coverage": round(float(cov_scores[i]),3),
                "token_hits": cov_dbg[i].get("token_hits", []),
                "phrase_hits": cov_dbg[i].get("phrase_hits", [])
            }
        })

    debug = {
        "pool_sizes": {
            "vector": len(vranks), "bm25": len(branks),
            "fused": len(fused), "candidates": len(cand_ids),
            "post_filter_kept": len(filt_ids)
        },
        "signal": signal,
        "faiss_loaded": FAISS_IDX.get(app_name) is not None,
        "faiss_ids": len(FAISS_IDS.get(app_name, []))
    }
    return {"query": q, "app": app_name, "top_k": top_k, "results": results, "debug": debug}

@app.get("/neighbors")
def neighbors(app_name: str = Query("claims"), source_path: str = Query(...), seq_idx: int = Query(...), radius: int = Query(1), limit: int = Query(10)):
    coll = client.get_or_create_collection(pick_collection(app_name))
    res = coll.query(query_texts=["*"], n_results=1000, where={"app": app_name})
    ids, docs, metas = res["ids"][0], res["documents"][0], res["metadatas"][0]
    out=[]
    for i,(id_,m) in enumerate(zip(ids,metas)):
        try:
            if m.get("source_path")==source_path and abs(int(m.get("seq_idx",-999))-int(seq_idx))<=int(radius):
                out.append({"id": id_, "document": docs[i], "metadata": m})
        except: pass
        if len(out)>=limit: break
    return {"results": out}

@app.post("/by_ids")
def by_ids(app_name: str = Query("claims"), ids: List[str] = Query(...)):
    coll = client.get_or_create_collection(pick_collection(app_name))
    res = coll.get(ids=list(ids))
    out=[]
    for id_, doc, meta in zip(res.get("ids",[]), res.get("documents",[]), res.get("metadatas",[])):
        out.append({"id": id_, "document": doc, "metadata": meta})
    return {"results": out}
