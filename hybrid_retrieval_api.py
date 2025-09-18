from fastapi import FastAPI, Query
from pydantic import BaseModel
from typing import List, Dict, Any
from pathlib import Path
import chromadb, pickle, numpy as np, yaml
from whoosh.qparser import MultifieldParser
from whoosh import index as wx

BASE = Path(__file__).resolve().parents[1]
CFG  = yaml.safe_load(open(BASE/"ingest"/"config.yaml","r",encoding="utf-8"))
PIPE = pickle.load(open(BASE/"models"/"tfidf_svd_384.pkl","rb"))
client = chromadb.HttpClient(host=CFG["chroma"]["host"], port=int(CFG["chroma"]["port"]))
IX_DIR = BASE/"data"/"whoosh"

def pick_collection(app: str) -> str:
    m = { c["app"]: c["name"] for c in CFG["collections"] }
    return m.get(app, next(iter(m.values())))

def qvec(q: str):
    v = PIPE.transform([q]); v = v.toarray() if hasattr(v,"toarray") else v
    return v[0].astype(np.float32).tolist()

def rrf(rankings, k=60):
    from collections import defaultdict
    s=defaultdict(float)
    for ranks in rankings:
        for doc,r in ranks.items(): s[doc]+=1.0/(k+r)
    return sorted(s.items(), key=lambda x:-x[1])

def mmr(candidate_vecs, query_vec, top_n=8):
    cand=np.array(candidate_vecs,dtype="float32")
    q=np.array(query_vec,dtype="float32")
    sim_q=(cand@q)/(np.linalg.norm(cand,axis=1)*np.linalg.norm(q)+1e-9)
    selected,rest=[],list(range(len(candidate_vecs)))
    while rest and len(selected)<top_n:
        if not selected:
            i=int(np.argmax(sim_q[rest])); selected.append(rest.pop(i)); continue
        sel=cand[selected]
        sim_div=cand[rest]@sel.T
        sim_div=(sim_div/(np.linalg.norm(cand[rest],axis=1,keepdims=True)*np.linalg.norm(sel,axis=1)+1e-9)).max(axis=1)
        score=0.7*sim_q[rest]-0.3*sim_div
        j=int(np.argmax(score)); selected.append(rest.pop(j))
    return selected

app = FastAPI(title="Hybrid Retrieval (TF-IDF→SVD + BM25 + RRF + MMR)")

class RetrieveResponse(BaseModel):
    query: str
    app: str
    top_k: int
    results: List[Dict[str, Any]]

@app.get("/retrieve", response_model=RetrieveResponse)
def retrieve(q: str = Query(...), app_name: str = Query("claims"), top_k: int = Query(8), pool: int = Query(50)):
    """
    Stateless hybrid retrieve:
      * TF-IDF→SVD vectors from Chroma
      * BM25 (Whoosh)
      * RRF fuse + MMR for diversity
    Returns compact chunks with metadata; no LLM logic here.
    """
    coll = client.get_or_create_collection(pick_collection(app_name))
    qv = qvec(q)

    # Vector search
    vres = coll.query(query_embeddings=[qv], n_results=max(pool, top_k*6), where={"app": app_name})
    v_ids, v_docs, v_meta = vres["ids"][0], vres["documents"][0], vres["metadatas"][0]
    vranks = {v_ids[i]: i+1 for i in range(len(v_ids))}

    # BM25
    ixp = IX_DIR/app_name
    branks = {}
    if ixp.exists():
        with wx.open_dir(ixp).searcher() as s:
            parser = MultifieldParser(["title","text"], schema=s.schema)
            bres = s.search(parser.parse(q), limit=max(pool, top_k*6))
            branks = {r["doc_id"]: i+1 for i,r in enumerate(bres)}

    # Fuse with RRF
    fused = rrf([vranks, branks] if branks else [vranks], k=60)
    cand_ids = [doc for doc,_ in fused if doc in vranks][:max(pool, top_k*6)]

    # MMR for diversity (approximate candidate vectors by re-embedding previews)
    cand_vecs, cand_docs, cand_meta = [], [], []
    idx_map = {v_ids[i]: i for i in range(len(v_ids))}
    for did in cand_ids:
        i = idx_map[did]
        cand_docs.append(v_docs[i]); cand_meta.append(v_meta[i]); cand_vecs.append(qvec(v_docs[i]))
    keep = mmr(cand_vecs, qv, top_n=top_k)

    results = []
    for i in keep:
        did = cand_ids[i]
        j = idx_map[did]
        results.append({
            "id": did,
            "document": v_docs[j],
            "metadata": v_meta[j]
        })
    return {"query": q, "app": app_name, "top_k": top_k, "results": results}

@app.get("/neighbors")
def neighbors(app_name: str = Query("claims"), source_path: str = Query(...), seq_idx: int = Query(...), radius: int = Query(1), limit: int = Query(10)):
    """
    Return chunks from the same file with seq_idx in [seq_idx-radius, seq_idx+radius]
    """
    coll = client.get_or_create_collection(pick_collection(app_name))
    # Pull a large slice and filter client-side (Chroma doesn't support range filters natively)
    res = coll.query(query_texts=["*"], n_results=1000, where={"app": app_name})
    ids, docs, metas = res["ids"][0], res["documents"][0], res["metadatas"][0]
    out = []
    for i,(id_, m) in enumerate(zip(ids, metas)):
        try:
            if m.get("source_path")==source_path and abs(int(m.get("seq_idx",-999))-int(seq_idx)) <= int(radius):
                out.append({"id": id_, "document": docs[i], "metadata": m})
        except: 
            continue
        if len(out) >= limit: break
    return {"results": out}

@app.post("/by_ids")
def by_ids(app_name: str = Query("claims"), ids: List[str] = Query(...)):
    """
    Fetch specific chunk ids.
    """
    coll = client.get_or_create_collection(pick_collection(app_name))
    res = coll.get(ids=list(ids))
    out=[]
    for id_, doc, meta in zip(res.get("ids",[]), res.get("documents",[]), res.get("metadatas",[])):
        out.append({"id": id_, "document": doc, "metadata": meta})
    return {"results": out}
