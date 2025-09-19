# C:\chroma_stack\ingest\ingest_offline.py
from __future__ import annotations
import os, sys, re, json, time, pickle, hashlib, datetime as dt
from pathlib import Path
from typing import Dict, Any, List, Iterable

import yaml, numpy as np, chromadb
from chromadb.errors import InvalidDimensionError
from pypdf import PdfReader
from docx import Document

# local
from hierarchy import derive_hierarchy
from chunking import chunk_structured
from whoosh_index import get_or_create, upsert  # keep Whoosh

# NEW: FAISS
import faiss

# ------------ config / paths ------------
BASE = Path(__file__).resolve().parents[1]
CFG_PATH   = BASE / "ingest" / "config.yaml"
EMB_PATH   = BASE / "models" / "tfidf_svd_384.pkl"
WHOOSH_DIR = BASE / "data" / "whoosh"
FAISS_DIR  = BASE / "faiss"

# ------------ settings ------------
BATCH_SIZE = 256
PREVIEW_CHARS = 600
PDF_MAX_PAGES = 1500
SLEEP_BETWEEN_BATCHES = 0.05

# ------------ dedupe helpers ------------
_ws = re.compile(r"\s+")
_boiler = re.compile(r"(^\s*page\s+\d+\s*$)|(^\s*confidential\s*$)", re.I | re.M)

def normalize_for_hash(text: str) -> str:
    t = _boiler.sub(" ", text)
    t = t.lower()
    t = _ws.sub(" ", t).strip()
    return t

def chunk_sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def simhash(text: str, n=64) -> int:
    tokens = [w for w in re.findall(r"\b[\w\-]+\b", text.lower()) if w]
    if not tokens: return 0
    v = [0]*n
    for w in tokens:
        h = int(hashlib.md5(w.encode("utf-8")).hexdigest(), 16)
        for i in range(n):
            v[i] += 1 if ((h >> i) & 1) else -1
    out = 0
    for i in range(n):
        if v[i] >= 0: out |= (1 << i)
    return out

def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()

# ------------ utils ------------
def utc_now() -> str:
    return dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"

def log(msg: str): print(msg, flush=True)

def load_yaml(path: Path) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f: return yaml.safe_load(f)

def safe_file_size(p: str) -> int | None:
    try: return os.path.getsize(p)
    except FileNotFoundError: return None

# ------------ text loaders ------------
def load_text(path: str) -> str:
    p = path.lower()
    try:
        if p.endswith(".pdf"):   return load_pdf_text(path)
        if p.endswith(".docx"):  return load_docx_text(path)
        if p.endswith((".txt",".md")):
            return open(path, "r", encoding="utf-8", errors="ignore").read()
        return ""
    except Exception as e:
        log(f"  ! error reading {path}: {e}"); return ""

def load_pdf_text(path: str) -> str:
    out: List[str] = []
    with open(path, "rb") as f:
        r = PdfReader(f); n = min(len(r.pages), PDF_MAX_PAGES)
        for i in range(n):
            try:  txt = r.pages[i].extract_text() or ""
            except: txt = ""
            if txt.strip(): out.append(txt)
    return "\n".join(out)

def load_docx_text(path: str) -> str:
    with open(path, "rb") as f:
        d = Document(f)
        return "\n".join(p.text for p in d.paragraphs)

# ------------ embedder ------------
class Embedder:
    def __init__(self, pipe):
        self.pipe = pipe
        probe = self._transform(["probe"])
        self.dim = int(probe.shape[1])

    def _transform(self, texts: List[str]):
        m = self.pipe.transform(texts)
        if hasattr(m, "toarray"): m = m.toarray()
        return m

    def embed_list(self, texts: List[str]) -> List[List[float]]:
        arr = self._transform(texts).astype(np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-9
        arr = arr / norms
        return [row.tolist() for row in arr]

# ------------ batching ------------
def batched(seq: List[Any], n: int) -> Iterable[List[Any]]:
    for i in range(0, len(seq), n): yield seq[i:i+n]

# ------------ main ------------
def main():
    if not CFG_PATH.exists(): raise SystemExit(f"Missing config: {CFG_PATH}")
    cfg = load_yaml(CFG_PATH)
    if not EMB_PATH.exists(): raise SystemExit(f"Missing embedder pickle: {EMB_PATH}")
    with open(EMB_PATH, "rb") as f: pipe = pickle.load(f)
    emb = Embedder(pipe)
    log(f"Embedder loaded. dim={emb.dim}")

    # Chroma
    client = chromadb.HttpClient(
        host=cfg["chroma"]["host"], port=int(cfg["chroma"]["port"]),
        ssl=bool(cfg["chroma"].get("ssl", False)), headers=cfg["chroma"].get("headers") or {}
    )

    include_exts = set(e.lower() for e in cfg["include_extensions"])
    max_bytes = int(cfg.get("max_mb",25))*1024*1024

    WHOOSH_DIR.mkdir(parents=True, exist_ok=True)
    FAISS_DIR.mkdir(parents=True, exist_ok=True)

    # Dedupe caches
    seen_hashes: set[str] = set()
    seen_simhashes: List[int] = []
    exact_dups_skipped = 0
    near_dups_skipped  = 0

    whoosh_ix_by_app = {}
    def ix_for(app: str):
        if app not in whoosh_ix_by_app:
            whoosh_ix_by_app[app] = get_or_create(WHOOSH_DIR / app)
        return whoosh_ix_by_app[app]

    # For FAISS (per app) we collect vectors & aligned ids
    faiss_vectors_by_app: Dict[str, List[List[float]]] = {}
    faiss_ids_by_app: Dict[str, List[str]] = {}

    for coll_cfg in cfg["collections"]:
        coll_name = coll_cfg["name"]; app = coll_cfg["app"]
        log(f"\n=== [{coll_name}] (app={app}) ===")
        try:
            coll = client.get_or_create_collection(
                name=coll_name,
                metadata={"embedder":"tfidf_svd_384","hnsw:space":"cosine"}
            )
        except InvalidDimensionError as e:
            raise SystemExit(f"Incompatible Chroma dim for '{coll_name}'. Delete/recreate. {e}")

        ix = ix_for(app); to_upsert_bm25: List[Dict[str, Any]] = []
        file_count = chunk_count = 0
        roots = [r for r in cfg["roots"] if r.get("app")==app]
        if not roots: log(f"  ! No roots for app '{app}', skip"); continue

        # create per-app holders
        faiss_vectors_by_app.setdefault(app, [])
        faiss_ids_by_app.setdefault(app, [])

        for root in roots:
            root_path = root["path"]; log(f"  Walking: {root_path}")
            for dirpath, _, files in os.walk(root_path):
                for fn in files:
                    full = os.path.join(dirpath, fn)
                    ext = os.path.splitext(full)[1].lower()
                    if ext not in include_exts: continue
                    size = safe_file_size(full)
                    if size is None or size > max_bytes: 
                        if size and size>max_bytes: log(f"  - skip (>{cfg.get('max_mb',25)}MB): {full}")
                        continue

                    text = load_text(full)
                    if not text.strip(): continue

                    chs = chunk_structured(text, cfg["chunk"]["tokens"], cfg["chunk"]["overlap"])
                    if not chs: continue

                    ids: List[str] = []; docs: List[str] = []; metas: List[Dict[str,Any]] = []; payload_texts: List[str] = []
                    base_meta = derive_hierarchy(root, full)

                    for ch in chs:
                        piece = (ch["body"] or "").strip()
                        if not piece: continue
                        norm = normalize_for_hash(piece)
                        hid  = chunk_sha256(norm)
                        if hid in seen_hashes:
                            exact_dups_skipped += 1; continue
                        sh   = simhash(norm)
                        if any(hamming(sh, prev) <= 3 for prev in seen_simhashes):
                            near_dups_skipped += 1; continue
                        seen_hashes.add(hid); seen_simhashes.append(sh)

                        cid = f"h:{hid}"
                        ids.append(cid)
                        docs.append(piece[:PREVIEW_CHARS])
                        meta = {
                            **base_meta, "kind":"doc","app":app,"source_path":full,
                            "section_title": ch.get("title") or "", "seq_idx": int(ch.get("seq_idx",0)),
                            "ingested_at": utc_now(), "hash": hid, "simhash": sh
                        }
                        metas.append(meta)
                        payload_texts.append(piece)

                    if not ids: continue

                    # embed & upload to Chroma (batched)
                    for b_ids, b_docs, b_metas, b_texts in zip(
                        batched(ids, BATCH_SIZE), batched(docs, BATCH_SIZE),
                        batched(metas, BATCH_SIZE), batched(payload_texts, BATCH_SIZE)
                    ):
                        vecs = emb.embed_list(b_texts)  # normalized
                        coll.add(ids=list(b_ids), documents=list(b_docs), metadatas=list(b_metas), embeddings=vecs)
                        # collect for FAISS (keep same order)
                        faiss_vectors_by_app[app].extend(vecs)
                        faiss_ids_by_app[app].extend(list(b_ids))
                        time.sleep(SLEEP_BETWEEN_BATCHES)

                    # Whoosh stage (raw text)
                    for i, piece in enumerate(payload_texts):
                        to_upsert_bm25.append({
                            "doc_id": ids[i], "app": app,
                            "title": metas[i]["section_title"] or "",
                            "text": piece, "source": metas[i]["source_path"]
                        })

                    file_count += 1; chunk_count += len(ids)
                    log(f"    + {len(ids):4d} chunks   {full}")

                    if len(to_upsert_bm25) >= 5000:
                        upsert(ix, to_upsert_bm25); log(f"  [BM25] committed {len(to_upsert_bm25)} docs"); to_upsert_bm25.clear()

        if to_upsert_bm25:
            upsert(ix, to_upsert_bm25); log(f"  [BM25] committed {len(to_upsert_bm25)} docs")

        log(f"=== done: files={file_count}, chunks={chunk_count} ===")

    # Build/save FAISS indexes per app
    for app, vecs in faiss_vectors_by_app.items():
        ids = faiss_ids_by_app.get(app, [])
        if not vecs or not ids:
            log(f"[FAISS] skip app={app} (no vectors)")
            continue
        arr = np.array(vecs, dtype="float32")
        dim = arr.shape[1]
        index = faiss.IndexFlatIP(dim)  # cosine (vectors already L2-normalized)
        index.add(arr)
        out_idx = FAISS_DIR / f"{app}.faiss"
        out_ids = FAISS_DIR / f"{app}_ids.json"
        faiss.write_index(index, str(out_idx))
        with open(out_ids, "w", encoding="utf-8") as f:
            json.dump(ids, f, ensure_ascii=False)
        log(f"[FAISS] wrote {out_idx} and {out_ids} (rows={len(ids)}, dim={dim})")

    log(f"  [dedupe] exact_skipped={exact_dups_skipped} near_skipped={near_dups_skipped}")
    log("\nAll collections ingested successfully.")

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: print("\nInterrupted."); sys.exit(1)
    except Exception as e: print(f"\nFATAL: {e}"); sys.exit(2)
